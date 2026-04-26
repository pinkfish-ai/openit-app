// Tiny shared helper so both the engine adapter (`entities/datastore.ts`)
// and the wrapper (`datastoreSync.ts`) can paginate /memory/bquery without
// a circular import between them.

import { listItems, type MemoryBqueryResponse } from "../skillsApi";
import { derivedUrls, getToken, type PinkfishCreds } from "../pinkfishAuth";

export async function fetchDatastoreItems(
  creds: PinkfishCreds,
  collectionId: string,
  limit?: number,
  offset?: number,
): Promise<MemoryBqueryResponse> {
  const token = getToken();
  if (!token) throw new Error("not authenticated");
  const urls = derivedUrls(creds.tokenUrl);
  return listItems(urls.skillsBaseUrl, token.accessToken, collectionId, limit, offset);
}
