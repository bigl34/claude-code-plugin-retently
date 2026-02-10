<!-- AUTO-GENERATED README — DO NOT EDIT. Changes will be overwritten on next publish. -->
# claude-code-plugin-retently

Dedicated agent for Retently NPS/CSAT feedback operations with isolated API access

![Version](https://img.shields.io/badge/version-1.0.6-blue) ![License: MIT](https://img.shields.io/badge/License-MIT-green) ![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

## Features

- Read Operations (Always Allowed)
- **list-customers** — List customers
- **get-customer** — Get customer by ID
- **list-feedback** — List survey responses
- **get-feedback** — Get feedback by ID
- **get-nps-score** — Current NPS score
- **get-csat-score** — Current CSAT score
- **get-ces-score** — Current CES score
- **list-campaigns** — List survey campaigns
- **list-companies** — List companies with metrics
- **api-status** — Show rate limit info
- **list-tools** — List all commands
- **cache-stats** — Show cache statistics
- **cache-clear** — Clear all cache
- **cache-invalidate** — Invalidate cache
- Write Operations (Require Explicit User Command)
- **create-customers** — Bulk create/update (max 1000)
- **delete-customer** — Delete by email
- **send-survey** — Trigger survey
- **add-tags** — Tag feedback

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- API credentials for the target service (see Configuration)

## Quick Start

```bash
git clone https://github.com/YOUR_GITHUB_USER/claude-code-plugin-retently.git
cd claude-code-plugin-retently
cp config.template.json config.json  # fill in your credentials
cd scripts && npm install
```

```bash
node scripts/dist/cli.js list-customers
```

## Installation

1. Clone this repository
2. Copy `config.template.json` to `config.json` and fill in your credentials
3. Install dependencies:
   ```bash
   cd scripts && npm install
   ```

## Available Commands

### Read Operations (Always Allowed)

| Command            | Description                 | Key Flags                                                            |
| ------------------ | --------------------------- | -------------------------------------------------------------------- |
| `list-customers`   | List customers              | `--limit`, `--page`, `--email`                                       |
| `get-customer`     | Get customer by ID          | `--id`                                                               |
| `list-feedback`    | List survey responses       | `--limit`, `--page`, `--since`, `--until`, `--campaign-id`, `--sort` |
| `get-feedback`     | Get feedback by ID          | `--id`                                                               |
| `get-nps-score`    | Current NPS score           | (none)                                                               |
| `get-csat-score`   | Current CSAT score          | (none)                                                               |
| `get-ces-score`    | Current CES score           | (none)                                                               |
| `list-campaigns`   | List survey campaigns       | `--limit`                                                            |
| `list-companies`   | List companies with metrics | `--limit`, `--page`                                                  |
| `api-status`       | Show rate limit info        | (none)                                                               |
| `list-tools`       | List all commands           | (none)                                                               |
| `cache-stats`      | Show cache statistics       | (none)                                                               |
| `cache-clear`      | Clear all cache             | (none)                                                               |
| `cache-invalidate` | Invalidate cache            | `--key`, `--pattern`                                                 |

### Write Operations (Require Explicit User Command)

| Command            | Description                   | Key Flags                                  |
| ------------------ | ----------------------------- | ------------------------------------------ |
| `create-customers` | Bulk create/update (max 1000) | `--data` (JSON array)                      |
| `delete-customer`  | Delete by email               | `--email`                                  |
| `send-survey`      | Trigger survey                | `--email`, `--campaign-id`, `--delay-days` |
| `add-tags`         | Tag feedback                  | `--feedback-id`, `--tags`                  |

## Usage Examples

```bash
node scripts/dist/cli.js get-nps-score
```

```bash
node scripts/dist/cli.js list-feedback --limit 10 --sort desc
```

```bash
node scripts/dist/cli.js list-feedback --since 2024-01-15 --limit 50
```

```bash
node scripts/dist/cli.js list-customers --email john@example.com
```

```bash
node scripts/dist/cli.js create-customers --data '[{"email":"test@example.com","first_name":"Test"}]'
```

```bash
node scripts/dist/cli.js send-survey --email customer@example.com --campaign-id abc123 --delay-days 1
```

## How It Works

This plugin connects directly to the service's HTTP API. The CLI handles authentication, request formatting, pagination, and error handling, returning structured JSON responses.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Authentication errors | Verify credentials in `config.json` |
| `ERR_MODULE_NOT_FOUND` | Run `cd scripts && npm install` |
| Rate limiting | The CLI handles retries automatically; wait and retry if persistent |
| Unexpected JSON output | Check API credentials haven't expired |

## Contributing

Issues and pull requests are welcome.

## License

MIT
