# Connect with GitHub: registering the Arceo GitHub App

Private-repo scans go through a GitHub App (`backend/github_app.py`). The person
connecting picks exactly which repos Arceo can read, access is read-only, and
every token is a short-lived installation token. Until the env vars below are set,
the "Connect GitHub" UI stays hidden and scans work on public repos only.

## 1. Register the app (once per environment)

Go to https://github.com/settings/apps/new. Use the org's settings page instead
if the app should belong to an organization.

| Field | Production | Local dev (separate app, e.g. "Arceo Dev") |
|---|---|---|
| GitHub App name | `Arceo` | `Arceo Dev` |
| Homepage URL | `https://arceoai.app` | `http://localhost:5173` |
| Callback URL | `https://app.arceoai.app/api/integrations/github/callback` | `http://localhost:8000/api/integrations/github/callback` |
| Request user authorization (OAuth) during installation | ✅ on | ✅ on |
| Setup URL | (disabled by the option above) | |
| Webhook → Active | ❌ off | ❌ off |
| Repository permissions → Contents | Read-only | Read-only |
| Repository permissions → Metadata | Read-only (mandatory) | Read-only |
| Everything else | No access | No access |
| Where can this app be installed | Any account | Only this account |

After creating it:

1. Note the **App ID** and the **slug**, the last part of `https://github.com/apps/<slug>`.
2. Note the **Client ID**, then click **Generate a new client secret**.
3. Under **Private keys**, click **Generate a private key**. This downloads a `.pem` file.

## 2. Set the env vars

| Var | Value |
|---|---|
| `GITHUB_APP_ID` | App ID |
| `GITHUB_APP_SLUG` | slug |
| `GITHUB_APP_CLIENT_ID` | Client ID |
| `GITHUB_APP_CLIENT_SECRET` | client secret |
| `GITHUB_APP_PRIVATE_KEY` | contents of the `.pem`. Real newlines or literal `\n` escapes both work |

On Vercel, add these to the **Platform** project in the Production environment,
then redeploy. The connection is stored in the credential vault, so
`ARCEO_VAULT_MASTER_KEY` must also be set. It already is in Production.

Locally, export them in the backend shell, and set
`ARCEO_APP_URL=http://localhost:5173` so the callback returns to the Vite dev
server instead of the backend's port.

## 3. How it works

1. **Connect GitHub.** `POST /api/integrations/github/connect` mints a two-minute
   ticket. The browser trades it at `/start` for an HttpOnly, signed state cookie
   and is sent to GitHub's OAuth page.
2. **Callback.** `/callback` exchanges the code for a user token and lists
   `/user/installations`. Only an installation that the connecting GitHub user can
   access is linked, so a forged `installation_id` query parameter is ignored. If
   the app isn't installed yet, the user is sent to the install page, and GitHub
   returns to the callback afterwards.
3. **Storage.** The link is stored as `provider_credentials` with provider
   `github_app`, one per workspace. That provider is deliberately not writable
   through the generic `PUT /api/credentials/{provider}`.
4. **Scans.** A scan tries credentials in order: installation token, then the
   workspace `github_scan` token, then the server `GITHUB_TOKEN`, then anonymous.
   **The server token is never used to read a private repo**: that is a credential
   the repo owner never granted.
5. **Uninstall.** If the app is uninstalled on GitHub, the next scan or repo list
   gets a 404 on the token and drops the link. The UI then offers Connect again.

## Recommended: a server `GITHUB_TOKEN` for public scans

Anonymous GitHub API calls are limited to 60 per hour per IP, and Vercel's
egress IPs are shared. A fine-grained token with **no repository access**
(public repos only) raises that to 5,000 per hour. Private repos stay behind
Connect GitHub.
