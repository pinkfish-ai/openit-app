# Integration Tests

Real integration tests that run against actual backends without mocking. These tests verify end-to-end behavior of the filestore sync system.

## Setup

### 1. Create test config

Copy the example config:
```bash
cp test-config.example.json test-config.json
```

### 2. Fill in credentials

Edit `test-config.json` with your real credentials:

```json
{
  "repo": "/path/to/test/repo",
  "orgId": "your-org-id",
  "credentials": {
    "tokenUrl": "https://oauth.dev20.pinkfish.dev",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret"
  },
  "collections": {
    "docs": "collection-id-for-docs",
    "attachments": "collection-id-for-attachments",
    "library": "collection-id-for-library"
  }
}
```

**⚠️ IMPORTANT**: `test-config.json` is git-ignored. Never commit credentials.

### 3. Get credentials

From the OAuth endpoint:
```bash
curl -X POST "https://app-api.dev20.pinkfish.dev/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET" \
  -d "scope=org:YOUR_ORG_ID"
```

## Running Tests

### Run all integration tests
```bash
npm run test:integration
```

### Run specific test file
```bash
npm test -- --config vitest.integration.config.ts filestore-sync.test.ts
```

### Watch mode (re-run on file changes)
```bash
npm test -- --config vitest.integration.config.ts --watch
```

### Verbose output
```bash
npm test -- --config vitest.integration.config.ts --reporter=verbose
```

## How Tests Skip If Config Missing

If `test-config.json` doesn't exist, integration tests are automatically skipped with a message pointing to the setup instructions. This allows the test suite to run in CI without credentials.

## Test Structure

```
integration_tests/
├── README.md                    # This file
├── filestore-sync.test.ts       # Main filestore sync tests
├── utils/
│   ├── config.ts               # Load test config
│   └── mocks.ts                # Mock helpers
└── fixtures/                   # Test data and fixtures
```

## What Gets Tested

### filestore-sync.test.ts
1. **Discovery**: Lists files from real remote collections
2. **Routing**: Verifies files route to correct local folders
3. **Callbacks**: Checks fetchAndWrite functions are properly set up
4. **Collections**: Tests multiple collections simultaneously

## Troubleshooting

### Test config not found
```
test-config.json not found. Copy test-config.example.json to test-config.json
```
**Solution**: Follow setup steps above.

### Authentication failed
```
Error: HTTP 401: Unauthorized
```
**Solution**: Check credentials in test-config.json. Rotate credentials if exposed.

### Connection timeout
```
Timeout: did not complete within 30000ms
```
**Solution**: Check network connectivity and API endpoint availability.

### Tests skip silently
This is expected if `test-config.json` doesn't exist. Tests will skip with a note.

## Adding New Tests

1. Create new file in `integration_tests/`
2. Use `loadConfig()` to get test credentials
3. Use `skipIf(!config)` to skip if config missing
4. Run with: `npm test -- --config vitest.integration.config.ts your-test.test.ts`

Example:
```typescript
import { describe, it, skipIf } from "vitest";
import { loadConfig } from "./utils/config";

const config = loadConfig();

describe.skipIf(!config)("my integration test", () => {
  it("should test something real", async () => {
    // Use config.repo, config.credentials, etc.
  });
});
```

## CI/CD Notes

Integration tests are skipped in CI unless `test-config.json` is provided. To enable in CI:
1. Store credentials in CI environment variables
2. Build test-config.json from env vars before running tests:
   ```bash
   cat > test-config.json <<EOF
   {
     "repo": "$TEST_REPO",
     "orgId": "$TEST_ORG_ID",
     ...
   }
   EOF
   ```

## Debugging

Add console.log or use debugger:
```bash
node --inspect-brk ./node_modules/vitest/vitest.mjs \
  --config vitest.integration.config.ts filestore-sync.test.ts
```

Then open `chrome://inspect` in Chrome.
