# Domain Email Finder by Scalelist

Find verified business emails for any domain with full contact profiles (names, job titles, departments, seniority, and LinkedIn URLs).

You can also provide an optional `company_name` alongside each `domain` to increase matching accuracy and ensure the best enrichment results.

Powered by Scalelist — the email and phone finder trusted by over 30,000 users worldwide.

---

## How it works

1. You provide a list of company domains (e.g. `thescalelab.com`, `scalelist.com`) with an optional `company_name`, and a single `limit` (applies to all domains).
2. The Actor queries the Scalelist Domain API for each domain synchronously.
3. Every email found is validated and written as an individual row to the Apify Dataset.
4. You are charged **$0.029 per email found** (`email_found` event) — domains with zero results cost nothing.

---

## Input

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `domains` | ✅ | — | List of domains to search |
| `domains[].domain` | ✅ | — | Company domain to search, e.g. `thescalelab.com` |
| `domains[].company_name` | Optional | `null` | Company name (e.g. `The Scalelab`) — improves matching accuracy |
| `limit` | Optional | `10` | Maximum number of emails to return per domain (1–100, applied to all domains) |

### Example input

```json
{
  "domains": [
    {
      "domain": "thescalelab.com",
      "company_name": "The Scalelab"
    },
    {
      "domain": "scalelist.com",
      "company_name": "Scalelist"
    },
    {
      "domain": "stripe.com"
    }
  ],
  "limit": 10
}
```

---

## Output

Each found email produces one row in the Apify Dataset with detailed profile information. If a domain returns no emails or fails, a single audit row is written with `found: false`.

| Field | Type | Description |
| --- | --- | --- |
| `domain` | string | Company domain searched |
| `company_name` | string \| null | Company name returned by Scalelist or provided in input |
| `email` | string \| null | Found business email address (`null` if none found) |
| `first_name` | string \| null | Contact's first name |
| `last_name` | string \| null | Contact's last name |
| `job_title` | string \| null | Contact's job title / role |
| `department` | string \| null | Department (e.g. `sales`, `support`, `engineering`) |
| `seniority` | string \| null | Seniority level (e.g. `director`, `executive`, `manager`) |
| `linkedin_url` | string \| null | Direct LinkedIn profile link |
| `email_status` | string | `Found` · `catch all` · `Not found` · `Lookup failed` · `Charge limit reached` |
| `found` | boolean | `true` if an email was found |
| `charged` | boolean | `true` if this email result was charged via Apify PPE |

### Example output row

```json
{
  "domain": "thescalelab.com",
  "company_name": "The Scalelab",
  "email": "arnaud@thescalelab.com",
  "first_name": "Arnaud",
  "last_name": "Renoux",
  "job_title": "Sales Leader",
  "department": "sales",
  "seniority": null,
  "linkedin_url": "https://www.linkedin.com/in/arnaud-renoux-129aa949",
  "email_status": "catch all",
  "found": true,
  "charged": true
}
```

---

## Error handling

| Situation | Behaviour |
| --- | --- |
| Missing `domain` field | Entry is skipped with a warning; remaining domains continue |
| Zero emails found | Output row written with `email: null`, `found: false`, `charged: false` |
| Rate limit (429) | Exponential backoff, up to 5 automatic retries |
| Lookup error (4xx/5xx) | Output row written with `email_status: "Lookup failed"`, `charged: false` |
| Spend cap reached | Actor cleanly stops processing further domains to prevent overspend |
| Actor timeout | Actor stops before processing domains it cannot finish |

---

## Support

- [Scalelist Website](https://scalelist.com)
- [Scalelist Support](mailto:hello@scalelist.com)
