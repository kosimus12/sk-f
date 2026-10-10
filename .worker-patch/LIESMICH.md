# Worker-Patch für skfb-beratungsformular (temporär – vor Merge nach main löschen)

Ziel-Ordner auf Simons Mac: `~/ClaudeWorkspace/01_Finanzberatung/Finanzberatung/Webseite/beratungsformular`
Backup vorher: `_archiv/beratungsformular_2026-10-10_vor-vertragscheck.tgz`

1. `src/worker/vertragscheck.js` (neu) und `src/worker/mime.js` (Anhänge) kopieren, `tests/vertragscheck.test.mjs` dazu.
2. `src/worker/index.js`: `import { handleVertragscheck } from './vertragscheck.js';` und Route
   `if (url.pathname === '/api/vertragscheck' && request.method === 'POST') return await handleVertragscheck(request, env);`
   (ohne cors()-Wrapper, klassischer Form-POST mit 303-Redirect).
3. `src/worker/submit.js`: Bug `part.filename` -> `part.name` (Uploads wurden still verworfen).
4. `wrangler.toml` [vars]: `VC_NOTIFY_TO = "simon.kuper97@gmail.com,kontakt@sk-finanzberatung.de"`
5. `npm test`, dann `wrangler login` + `wrangler deploy`.
6. Google-Zugang erneuern: `node scripts/get-google-refresh-token.mjs` -> `wrangler secret put GOOGLE_REFRESH_TOKEN`
   (Refresh-Token liefert seit spätestens 10.10.2026 `invalid_grant`). OAuth-App in der Google Cloud auf „In Produktion“ stellen.
7. Test-Einsendung, danach sk-f-Branch nach main mergen.
