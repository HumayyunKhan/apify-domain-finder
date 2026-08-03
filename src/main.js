// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = 'https://api.scalelist.com/api/v1';
const SCALELIST_API_KEY = process.env.SCALELIST_API_KEY;
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

// Charged per email found — domains with zero results cost nothing.
const EVENT_NAME = 'email_found';
const RESERVE_USD = 0.10;        // compute reserve — pure API actor, negligible cost
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_LIMIT = 10;        // emails returned per domain when limit is not specified

// -----------------------------------------------------------------------------
// HTTP Helper
// -----------------------------------------------------------------------------

async function apiFetch(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'come_from': 'domain_email_finder_apify_actor',
        'Content-Type': 'application/json',
        'x-api-key': SCALELIST_API_KEY,
        ...(options.headers ?? {}),
      },
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Retry Helper — exponential backoff, cap at 30s
// -----------------------------------------------------------------------------

async function withRetry(fn, maxAttempts = 5) {
  let delay = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      log.warning(`Attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
}

// -----------------------------------------------------------------------------
// Validate internal Scalelist API key
// -----------------------------------------------------------------------------

async function validateApiKey() {
  const response = await apiFetch('/account');

  if (response.status === 401) {
    throw new Error('Invalid SCALELIST_API_KEY. Contact support.');
  }
  if (!response.ok) {
    throw new Error(`Failed validating API key (HTTP ${response.status})`);
  }

  const data = await response.json();
  if (data.credits <= 0) {
    throw new Error('No credits available in Scalelist account. Contact support.');
  }
  log.info(`Scalelist API key validated. Available credits: ${data.credits ?? 'unknown'}`);
  return data;
}

// -----------------------------------------------------------------------------
// Slack Notification
// -----------------------------------------------------------------------------

async function notifySlack(summary) {
  if (!SLACK_TOKEN?.trim() || !SLACK_CHANNEL?.trim()) {
    log.info('Slack credentials not set — skipping notification.');
    return;
  }

  const {
    type = 'end',
    totalDomains,
    domainsSearched,
    emailsFound,
    ppeCharged,
    creditsRemaining,
    capReached,
    runUrl,
  } = summary;

  let text;
  if (type === 'start') {
    text = [
      `*🚀 Scalelist Domain Email Finder — Run Started*`,
      `• Domains to search : *${totalDomains}*`,
      `• Credits left      : *${creditsRemaining ?? 'unknown'}*`,
      runUrl ? `• Run URL           : ${runUrl}` : null,
    ].filter(Boolean).join('\n');
  } else {
    const status = capReached ? ':warning: Ended early (spend cap)' : ':white_check_mark: Completed';
    text = [
      `*Scalelist Domain Email Finder — Run ${status}*`,
      `• Domains searched  : *${domainsSearched}*`,
      `• Emails found      : *${emailsFound}*`,
      `• PPE charged       : *${ppeCharged}*`,
      `• Credits left      : *${creditsRemaining ?? 'unknown'}*`,
      runUrl ? `• Run URL           : ${runUrl}` : null,
    ].filter(Boolean).join('\n');
  }

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SLACK_TOKEN}`,
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
    });

    const data = await res.json();
    if (data.ok) {
      log.info('Slack notification sent.');
    } else {
      log.warning(`Slack notification failed: ${data.error}`);
    }
  } catch (err) {
    log.warning(`Slack notification error: ${err.message}`);
  }
}

// -----------------------------------------------------------------------------
// Search a single domain for emails
// Returns normalised array of email objects or null on hard failure
// -----------------------------------------------------------------------------

async function searchDomain(domain, limit, company_name) {
  const response = await withRetry(async () => {
    const payload = { domain, limit };
    if (company_name) {
      payload.company_name = company_name;
      payload.company = company_name;
    }

    const res = await apiFetch('/email/domain', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (res.status === 429) throw new Error('Rate limited');
    if (res.status === 400) {
      const body = await res.text();
      // console.log(body);
      throw new Error(`Bad request: ${body}`);
    }
    if (!res.ok) throw new Error(`Domain search failed (HTTP ${res.status})`);

    return res;
  });

  const data = await response.json();
  // console.log(data);

  // Normalise: API returns { domain, organization, total, limit, contacts: [...] }
  const raw = data.contacts ?? data.emails ?? data.data ?? data ?? [];
  const items = Array.isArray(raw) ? raw : [];
  const orgName = data.organization?.trim() || company_name || null;

  // Normalise each item to a consistent shape (API returns camelCase fields)
  return items.map((item) => {
    if (typeof item === 'string') {
      return {
        email: item.trim(),
        first_name: null,
        last_name: null,
        company_name: orgName,
        job_title: null,
        department: null,
        seniority: null,
        linkedin_url: null,
        status: 'Found',
      };
    }

    const cleanStr = (val) => (typeof val === 'string' && val.trim().length > 0 ? val.trim() : null);

    return {
      email: cleanStr(item.email),
      first_name: cleanStr(item.firstName ?? item.first_name),
      last_name: cleanStr(item.lastName ?? item.last_name),
      company_name: cleanStr(item.company) ?? cleanStr(item.company_name) ?? orgName,
      job_title: cleanStr(item.jobTitle ?? item.job_title),
      department: cleanStr(item.department),
      seniority: cleanStr(item.seniority),
      linkedin_url: cleanStr(item.linkedinUrl ?? item.linkedin_url),
      status: cleanStr(item.status) ?? cleanStr(item.result) ?? 'Found',
    };
  });
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

await Actor.init();

// Graceful abort handler
Actor.on('aborting', async () => {
  log.info('Received abort — flushing and exiting.');
  await sleep(1000);
  await Actor.exit();
});

try {
  if (!SCALELIST_API_KEY?.trim()) {
    throw new Error('Missing SCALELIST_API_KEY environment variable. Contact support.');
  }

  const { domains } = (await Actor.getInput()) ?? {};

  if (!Array.isArray(domains) || domains.length === 0) {
    throw new Error('Input "domains" must be a non-empty array.');
  }

  // ── Input validation ──────────────────────────────────────────────────────
  const invalidEntries = domains.filter((d) => !d.domain?.trim());
  if (invalidEntries.length > 0) {
    log.warning(`${invalidEntries.length} entr(ies) missing domain field — skipping.`);
  }

  const validDomains = domains
    .filter((d) => d.domain?.trim())
    .map((d) => ({
      domain: d.domain.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/\/$/, ''),
      company_name: d.company_name?.trim() || d.companyName?.trim() || null,
      limit: Number(d.limit) > 0 ? Number(d.limit) : DEFAULT_LIMIT,
    }));

  if (validDomains.length === 0) {
    throw new Error('No valid domains provided. Each entry requires a "domain" field.');
  }

  // ── Budget check & estimation ─────────────────────────────────────────────
  const pricingInfo = Actor.getChargingManager().getPricingInfo();
  const maxRunCost = pricingInfo.maxTotalChargeUsd;
  const perEmailCost = pricingInfo.perEventPrices[EVENT_NAME] ?? 0;

  const maxEmailsAffordable = maxRunCost > 0 && perEmailCost > 0
    ? Math.floor((maxRunCost - RESERVE_USD) / perEmailCost)
    : Infinity;

  if (maxRunCost > 0 && perEmailCost > 0) {
    const available = maxRunCost - RESERVE_USD;
    if (available <= 0) {
      log.error(
        `maxTotalChargeUsd ($${maxRunCost.toFixed(2)}) is not greater than the $${RESERVE_USD} compute reserve. ` +
        `Please set a higher spend limit and re-run.`
      );
      await Actor.exit();
    }
    log.info(
      `Budget: max=$${maxRunCost.toFixed(2)} | reserve=$${RESERVE_USD} | per-email=$${perEmailCost.toFixed(4)} → max emails affordable: ${maxEmailsAffordable}`
    );
  } else {
    log.info('No budget cap set — processing all domains.');
  }

  log.info(`Processing ${validDomains.length} domain(s)...`);

  const accountData = await validateApiKey();

  const { actorRunId } = Actor.getEnv();
  const runUrl = actorRunId ? `https://console.apify.com/actors/runs/${actorRunId}` : null;

  await notifySlack({
    type: 'start',
    totalDomains: validDomains.length,
    creditsRemaining: accountData?.credits ?? null,
    runUrl,
  });

  const dataset = await Actor.openDataset();
  const counters = { searched: 0, found: 0, failed: 0, charged: 0 };
  let capReached = false;

  // No polling in this actor — each request is synchronous.
  // Timeout guard: just ensure each request has room to complete.
  const { timeoutAt } = Actor.getEnv();
  const MIN_TIME_PER_DOMAIN_MS = REQUEST_TIMEOUT_MS + 10_000;
  const hasTimeFor = () =>
    !timeoutAt || (timeoutAt - Date.now()) > MIN_TIME_PER_DOMAIN_MS;

  // ── Process domains sequentially ─────────────────────────────────────────
  for (const { domain, limit, company_name } of validDomains) {
    if (capReached) {
      log.warning('Spend cap reached from previous charge — skipping remaining domains.');
      break;
    }

    if (counters.charged >= maxEmailsAffordable) {
      log.warning(`Budget exhausted (${counters.charged}/${maxEmailsAffordable} emails charged) — stopping before next domain.`);
      break;
    }

    if (!hasTimeFor()) {
      const secsLeft = timeoutAt ? Math.round((timeoutAt - Date.now()) / 1000) : '?';
      log.warning(
        `Only ${secsLeft}s remaining (need >${Math.round(MIN_TIME_PER_DOMAIN_MS / 1000)}s per domain) — stopping.`
      );
      break;
    }

    log.info(`Searching domain: ${domain}${company_name ? ` (${company_name})` : ''} (limit: ${limit})...`);

    // ── Call domain email search API ──────────────────────────────────────────
    let emails = [];
    try {
      emails = await searchDomain(domain, limit, company_name);
      counters.searched++;
    } catch (err) {
      log.error(`Domain "${domain}" lookup failed: ${err.message}`);
      await dataset.pushData({
        domain,
        company_name: company_name ?? null,
        email: null,
        first_name: null,
        last_name: null,
        job_title: null,
        department: null,
        seniority: null,
        linkedin_url: null,
        email_status: 'Lookup failed',
        found: false,
        charged: false,
      });
      counters.failed++;
      continue;
    }

    // ── No emails found ───────────────────────────────────────────────────────
    if (emails.length === 0) {
      log.info(`No emails found for ${domain}.`);
      await dataset.pushData({
        domain,
        company_name: company_name ?? null,
        email: null,
        first_name: null,
        last_name: null,
        job_title: null,
        department: null,
        seniority: null,
        linkedin_url: null,
        email_status: 'Not found',
        found: false,
        charged: false,
      });
      continue;
    }

    // ── Charge for found emails ───────────────────────────────────────────────
    // Charge fires AFTER results arrive — only emails returned are billed.
    let actualCharged = 0;

    try {
      const chargeResult = await Actor.charge({ eventName: EVENT_NAME, count: emails.length });
      actualCharged = chargeResult.chargedCount;
      counters.charged += actualCharged;

      if (actualCharged < emails.length) {
        log.warning(
          `Charged ${actualCharged} of ${emails.length} found emails for "${domain}" — spend cap reached.`
        );
      }

      log.info(`Charged '${EVENT_NAME}' × ${actualCharged} for domain "${domain}".`);
      if (chargeResult.eventChargeLimitReached) capReached = true;
    } catch (err) {
      log.warning(`Actor.charge failed for "${domain}": ${err.message}`);
    }

    // ── Write one row per email to dataset ───────────────────────────────────
    // The first `actualCharged` rows get charged: true; the rest charged: false.
    let chargedSoFar = 0;

    for (const item of emails) {
      const charged = chargedSoFar < actualCharged;
      chargedSoFar++;

      if (item.email) counters.found++;

      await dataset.pushData({
        domain,
        company_name: item.company_name ?? company_name ?? null,
        email: item.email ?? null,
        first_name: item.first_name ?? null,
        last_name: item.last_name ?? null,
        job_title: item.job_title ?? null,
        department: item.department ?? null,
        seniority: item.seniority ?? null,
        linkedin_url: item.linkedin_url ?? null,
        email_status: charged ? (item.status ?? 'Found') : 'Charge limit reached',
        found: !!item.email,
        charged,
      });
    }

    log.info(`Domain "${domain}": ${emails.length} emails found, ${actualCharged} charged.`);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  log.info('='.repeat(60));
  log.info('Domain Email Finder — Run complete.');
  log.info(`Domains Processed : ${counters.searched}`);
  log.info(`Emails Found      : ${counters.found}`);
  log.info(`Lookup Failures   : ${counters.failed}`);
  log.info(`PPE Events        : ${counters.charged}`);
  if (capReached) log.warning('Run ended early — user spend cap reached.');
  log.info('='.repeat(60));

  // ── Slack notification ────────────────────────────────────────────────────
  await notifySlack({
    domainsSearched: counters.searched,
    emailsFound: counters.found,
    ppeCharged: counters.charged,
    creditsRemaining: accountData?.credits ?? null,
    capReached,
    runUrl,
  });

} catch (err) {
  log.exception(err, 'Actor failed.');
  throw err;
} finally {
  await Actor.exit();
}
