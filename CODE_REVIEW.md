# Code Review: Datastore/Filestore Sync Implementation

**Date:** 2026-04-25  
**Scope:** datastoreSync.ts, filestoreSync.ts, agentSync.ts, workflowSync.ts, PinkfishOauthModal.tsx  
**Overall Assessment:** **NEEDS FIXES** — Critical issues with global state management and error handling

---

## Critical Issues

### 🔴 CRITICAL: Global State Contamination (datastoreSync.ts, filestoreSync.ts)

**Location:** Lines 27, 33 (datastore) / Lines 82, 88 (filestore)

```typescript
let createdCollections = new Map<string, DataCollection>();
let lastCreationAttemptTime = 0;
```

**Problem:**
- Module-level mutable state persists across all function calls
- If user connects to **Org A**, creates collections, then connects to **Org B**, the cache from Org A will be returned for Org B
- The cooldown timer is shared globally, so Org A's creation cooldown blocks Org B's collection creation
- Collections from one org could be returned as valid for another org (data leakage)

**Impact:** Users could see/interact with collections from previous orgs. Data integrity issue.

**Fix Required:**
```typescript
// Use org-scoped cache keys
let createdCollections = new Map<string, Map<string, DataCollection>>();
let lastCreationAttemptTime = new Map<string, number>();

// Then key by: `createdCollections.get(creds.orgId)?.get(collectionName)`
// And: `lastCreationAttemptTime.get(creds.orgId) ?? 0`
```

---

### 🔴 CRITICAL: Stale Cache Returns Phantom Collections (datastoreSync.ts)

**Location:** Lines 68-71

```typescript
if (matching.length === 0 && createdCollections.size > 0) {
  console.log(`[datastoreSync] using ${createdCollections.size} recently created collections`);
  matching = Array.from(createdCollections.values());
}
```

**Problem:**
- If API returns empty list AND cache has items, returns cache items without verification
- These cached items might be:
  - Phantom collections that were never actually created
  - Collections that failed creation but were cached with a temporary ID
  - Collections from a previous failed sync attempt
- No validation that cached IDs actually correspond to real collections in the API

**Impact:** App returns collections that don't exist in the backend. Attempts to fetch/modify them will fail with 403/404 errors.

**Fix Required:**
```typescript
// Option 1: Don't return unverified cache
// Just let the function continue, the re-fetch will validate

// Option 2: Add verification before returning
if (matching.length === 0 && createdCollections.size > 0) {
  // Only return cache if it was verified in this session (< 30 seconds old)
  if (Date.now() - lastCreationAttemptTime < 30_000) {
    matching = Array.from(createdCollections.values());
  }
}
```

---

### 🔴 CRITICAL: Swallowing Sync Errors in Modal (PinkfishOauthModal.tsx)

**Location:** Lines 74-88

```typescript
await resolveProjectDatastores(creds).catch((e) => {
  addLog(`[sync] ⚠ Datastore sync failed: ${e}`);
});
addLog("[sync] ✓ Datastores synced");
```

**Problem:**
- Using `.catch()` but then immediately logging "✓ Datastores synced" 
- Even if the promise rejects, the next line runs and says "synced successfully"
- User thinks sync succeeded when it actually failed
- Creates false sense of security

**Impact:** Silent failures. Collections not created but user thinks they are.

**Fix Required:**
```typescript
try {
  addLog("[sync] Resolving datastores...");
  await resolveProjectDatastores(creds);
  addLog("[sync] ✓ Datastores synced");
} catch (e) {
  addLog(`[sync] ✗ Datastore sync failed: ${e}`);
  throw e; // Re-throw to stop sync process
}
```

---

## High Priority Issues

### 🟠 HIGH: Missing Error Handling for response.json()

**Location:** Lines 122, 156 (datastore) / Line 162 (filestore)

```typescript
const result = (await response.json()) as DataCollection[] | null;
```

**Problem:**
- `response.json()` can throw if response isn't valid JSON
- No try-catch around it
- If malformed JSON, entire sync crashes silently (caught only by outer try-catch)

**Impact:** Network issues or API returning invalid JSON crashes sync with generic error message.

**Fix Required:**
```typescript
let result: DataCollection[] | null;
try {
  result = (await response.json()) as DataCollection[] | null;
} catch (e) {
  console.error("[datastoreSync] failed to parse JSON response:", e);
  throw new Error(`Failed to parse collection list: ${e}`);
}
```

---

### 🟠 HIGH: Type Safety Issue - `any` Type (datastoreSync.ts)

**Location:** Line 122

```typescript
const result = (await response.json()) as any;
```

**Problem:**
- Using `any` defeats TypeScript's type safety
- Future developers won't know what shape to expect
- Could miss fields if API response changes

**Fix Required:**
```typescript
type CreateCollectionResponse = {
  id?: string | number;
  message?: string;
  schema?: Record<string, unknown>;
  [key: string]: unknown;
};

const result = (await response.json()) as CreateCollectionResponse | null;
const id = result?.id || result?.data?.id || result?.collection?.id;
```

---

### 🟠 HIGH: Inconsistent Error Handling Between Datastore and Filestore

**Location:** datastoreSync.ts (line 138) vs filestoreSync.ts (line 162-167)

**Problem:**
- datastoreSync logs when no ID found: `console.warn(...no id in response...)`
- filestoreSync silently skips: `if (result?.id) { ... }` with no else clause
- Different behavior makes debugging harder

**Fix:** Both should have consistent warning when ID is missing.

---

## Medium Priority Issues

### 🟡 MEDIUM: Hardcoded Eventual Consistency Timeout Mismatch

**Location:** Lines 150 (datastore), 178 (filestore)

**Problem:**
- Comment says "collections take ~5 seconds to appear"
- Code waits only 2000ms (2 seconds)
- In slow API scenarios, newly created collections won't be found yet
- Re-fetch will fail silently and return cached collections

**Impact:** Stale cache returned more often than necessary.

**Fix:**
```typescript
// Increase timeout or make configurable
await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds, matching comment
```

---

### 🟡 MEDIUM: Excessive State Updates in Modal

**Location:** Lines 37-39 (PinkfishOauthModal.tsx)

```typescript
const addLog = (msg: string) => {
  console.log(msg);
  setSyncLogs((prev) => [...prev, msg]);
};
```

**Problem:**
- Each log message triggers a full component re-render
- For sync process with 50+ log lines, causes many re-renders
- Performance issue: array spread creates new array each time

**Impact:** Slow/laggy UI during sync for large logs.

**Fix:**
```typescript
const logsRef = useRef<string[]>([]);

const addLog = (msg: string) => {
  console.log(msg);
  logsRef.current.push(msg);
  setSyncLogs([...logsRef.current]); // Batch update, debounce if needed
};

// Or use a key like `lastLogTime` to trigger re-render only when needed
```

---

### 🟡 MEDIUM: No Timeout on Sync Process

**Location:** Lines 72-91 (PinkfishOauthModal.tsx)

**Problem:**
- Sync can hang indefinitely if API doesn't respond
- No timeout, no cancel button during sync
- User is stuck waiting forever with no way out

**Impact:** Poor UX if sync hangs. User can't cancel.

**Fix:**
```typescript
const syncTimeoutMs = 30_000; // 30 second timeout
const timeoutHandle = setTimeout(() => {
  setSyncing(false);
  setError("Sync timed out after 30 seconds");
}, syncTimeoutMs);

try {
  // ... sync operations ...
} finally {
  clearTimeout(timeoutHandle);
}
```

---

### 🟡 MEDIUM: Confusing Double Logging

**Location:** PinkfishOauthModal.tsx + all sync functions

**Problem:**
- Modal logs: `----BEGIN SYNC----`
- Then each function logs: `----BEGIN DATASTORE SYNC----`
- Results in nested/confusing log structure:
  ```
  ----BEGIN SYNC----
  Syncing datastores, agents, and workflows...
  [sync] Resolving datastores...
  ----BEGIN DATASTORE SYNC----
  [datastoreSync] resolveProjectDatastores called
  ...
  ----END DATASTORE SYNC----
  ```

**Impact:** Confusing to read. Hard to tell where each phase starts/ends.

**Fix:** Choose one approach:
- Option A: Remove individual function BEGIN/END logs
- Option B: Only log in functions, not in modal

---

### 🟡 MEDIUM: Missing Return Type on fetchDatastoreSchema

**Location:** Lines 193-202 (datastoreSync.ts)

```typescript
export async function fetchDatastoreSchema(
  creds: PinkfishCreds,
  collectionId: string,
): Promise<any> {
  const collection = await getCollection(...);
  return collection.schema; // Could be undefined!
}
```

**Problem:**
- Returns `any` instead of `Schema | undefined`
- Callers don't know if schema exists
- FileExplorer checks `if (schema || resp.schema)` but type system doesn't help

**Impact:** Unclear API contract. Callers might not handle undefined.

**Fix:**
```typescript
export async function fetchDatastoreSchema(
  creds: PinkfishCreds,
  collectionId: string,
): Promise<DataCollectionSchema | undefined> {
  const collection = await getCollection(...);
  return collection.schema;
}
```

---

### 🟡 MEDIUM: Outdated Comment

**Location:** Line 31 (datastoreSync.ts)

```typescript
/**
 * Find or create openit-* Datastore collections. Creates defaults if none
 * exist. Uses the skills REST API (GET /datacollection/all).
 */
```

**Problem:** Says `/datacollection/all` but code uses `/datacollection/?type=datastore`

**Fix:** Update comment to match actual endpoint.

---

## Low Priority Issues

### 🟢 LOW: Inefficient fetchFn Creation

**Location:** Line 92 (datastoreSync.ts)

**Problem:**
```typescript
for (const def of defaults) {
  const fetchFn = makeSkillsFetch(token.accessToken); // Created in loop
  const response = await fetchFn(url.toString(), { ... });
}
```

**Impact:** Minor. Creating new fetch function instance each iteration is inefficient.

**Fix:** Move outside loop:
```typescript
const fetchFn = makeSkillsFetch(token.accessToken);
for (const def of defaults) {
  const response = await fetchFn(url.toString(), { ... });
}
```

---

### 🟢 LOW: Inconsistent Log Format

**Location:** Various

**Problem:**
- Some logs use `✓`, some use `✗`, some use `⚠`
- Some use `[datastoreSync]`, some use `[datastore]`
- Some use "Datastores synced", some use "Datastore sync failed"

**Impact:** Minor consistency issue. Already readable enough.

**Fix:** Standardize format across all functions.

---

## Summary Table

| Issue | Severity | Type | Fix Effort |
|-------|----------|------|-----------|
| Global state contamination (org mixing) | 🔴 CRITICAL | Bug | Medium |
| Stale cache returns phantom collections | 🔴 CRITICAL | Bug | Medium |
| Swallowing sync errors in modal | 🔴 CRITICAL | Logic | Low |
| Missing JSON error handling | 🟠 HIGH | Reliability | Low |
| Type safety (`any` usage) | 🟠 HIGH | Code Quality | Low |
| Inconsistent error logging | 🟠 HIGH | Consistency | Low |
| Eventual consistency timeout too short | 🟡 MEDIUM | Bug | Low |
| Excessive state updates | 🟡 MEDIUM | Performance | Low |
| No sync timeout | 🟡 MEDIUM | Feature | Medium |
| Double logging | 🟡 MEDIUM | UX | Low |
| Outdated comment | 🟢 LOW | Docs | Trivial |
| Inefficient fetchFn creation | 🟢 LOW | Perf | Trivial |

---

## Recommended Action Plan

**Priority 1 (Fix Immediately):**
1. Fix global state to be org-scoped (critical data integrity issue)
2. Fix error swallowing in modal (critical silent failures)
3. Fix stale cache returning phantom collections (critical data mismatch)

**Priority 2 (Fix Before Shipping):**
1. Add JSON parse error handling
2. Remove `any` types, use proper types
3. Make error handling consistent
4. Add sync timeout with cancel option

**Priority 3 (Nice to Have):**
1. Fix double logging structure
2. Optimize state updates
3. Fix eventual consistency timeout
4. Minor code quality improvements

