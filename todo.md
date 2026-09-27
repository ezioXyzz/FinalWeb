# EzioCloud project tracker

## Completed
- [x] Added the supplied 1920×823 dashboard banner, Drive search, and reduced-motion-friendly browsing/auth animations.
- [x] Preserved the original login and added the two requested server-side accounts.
- [x] Assigned admin rights only to `imira`; other accounts can upload/download and browse shared Notes but cannot change storage settings.
- [x] Raised the per-file upload limit to 20 MiB; uploads above 5 MiB use Google Drive’s resumable protocol.
- [x] Kept a 50 MB request-body limit so base64-encoded uploads below the file cap fit safely.
- [x] Added Notes & Links with searchable titles, URLs, and notes, category filters, single-link entry, and bulk paste (up to 100 URLs, one per line).
- [x] Persisted shared links in the database and applied the additive schema migration; links are readable by all signed-in accounts and manageable only by Imira.
- [x] Updated the upload warning and file-download availability to match the 20 MiB limit.
- [x] Type check and all 34 tests passed; production build and `git diff --check` passed.
- [x] Browser-verified the Notes view and Imira link editor without adding test data; preview left signed out.

## Shared access note
The Notes & Links collection is available to all signed-in EzioCloud users. All logins still use the same connected Google Drive workspace; they are not separate per-user Drive accounts.
