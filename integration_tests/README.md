# Integration Tests

Real integration tests that run against the live Pinkfish backend.
Use these instead of restart-and-retry loops on the running app.

## Setup

### 1. Create test config

```bash
cp test-config.example.json test-config.json
```

`test-config.json` is git-ignored — never commit it.

### 2. Fill in your credentials

```json
{
  "repo": "/Users/yourname/OpenIT/local",
  "orgId": "your-org-id",
  "credentials": {
    "tokenUrl": "https://app-api.dev20.pinkfish.dev/oauth/token",
    "webUrl": "https://dev20.pinkfish.dev",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret"
  }
}
```

Notes:
- `tokenUrl` is the **full** OAuth endpoint URL including `/oauth/token`.
  Mirror the curl pattern: `curl -X POST "$TOKEN_URL" ...`.
- `webUrl` is the web app URL for the same environment (informational).
- Skills API URL (`skills-stage.pinkfish.ai` for dev, `skills.pinkfish.ai`
  for prod) is derived automatically from `tokenUrl`.
- **Collection IDs are NOT in the config** — they're discovered at test time
  by name. IDs change when collections are recreated; names are stable.

### 3. (Optional) Verify OAuth from the shell

```bash
curl -X POST "https://app-api.dev20.pinkfish.dev/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "scope=org:YOUR_ORG_ID"
```

If this returns a token, the integration tests will too.

## Running Tests

```bash
npm run test:integration                    # one-shot
npm run test:integration:watch              # rerun on file changes
npm run test:integration -- --reporter=verbose   # see all stdout
```

If `test-config.json` is absent the suite skips silently — safe for CI.

## Layout

```
integration_tests/
├── README.md                  # this file
├── filestore-sync.test.ts     # filestore discovery + routing
└── utils/
    ├── config.ts              # load test-config.json + URL derivation
    ├── auth.ts                # OAuth client_credentials flow
    └── pinkfish-api.ts        # PinkfishClient: list collections + items
```

## What Gets Tested

`filestore-sync.test.ts`:
1. OAuth — the client_credentials grant returns an access token
2. Discovery — `GET /datacollection/?type=filestorage` returns all collections
3. openit-* filtering — `openit-` prefix selection
4. List items — `GET /filestorage/items?collectionId=…&format=full` per collection
5. Routing — `openit-foo` → `filestores/foo/` (verified for default + dynamic names)

The test calls the same skills API endpoints the Tauri backend uses. The
only thing not covered here is the actual file download (which goes through
the Tauri command surface, not directly fetchable from Node).

## Adding a New Test

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "./utils/config";
import { PinkfishClient } from "./utils/pinkfish-api";

const config = loadConfig();

describe.skipIf(!config)("my new test", () => {
  it("does something real", async () => {
    const client = new PinkfishClient(config!);
    const collections = await client.listCollections("filestorage");
    expect(collections.length).toBeGreaterThan(0);
  });
});
```

`PinkfishClient` already handles the right header (`Auth-Token`, not
`Authorization`) and the right base URLs.

## Troubleshooting

**"test-config.json not found"** — copy the example and fill it in.

**"HTTP 401"** — bad credentials. Re-run the curl from step 3.

**"HTTP 404 ... Route GET /datacollection/{id}/items not found"** — wrong
endpoint. The right one is `/filestorage/items?collectionId=…`. (Already
fixed in `pinkfish-api.ts`; only relevant if you're writing a new caller.)

**"getaddrinfo ENOTFOUND"** — your machine can't reach the Pinkfish
infra. Check VPN / network.
