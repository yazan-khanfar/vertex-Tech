# Smart Dental Clinic

The editable application is at the repository root. The original ZIP is retained as an archive; changes belong in the source files, not a second extracted copy.

## Development

Requires Node >=20.12, npm, PostgreSQL >=15, and Chromium for PDF reports. Docker can supply the local development database.

```bash
npm ci
node scripts/configure-local.js
bash scripts/dev-database.sh
npm run db:init       # EMPTY database only; refuses an existing schema
# Existing databases use npm run db:migrate instead.
npm run db:seed:patient
npm run db:seed:doctor
npm run db:seed:admin # explicit bootstrap; prompts privately, never seeds a default password
npm run dev
```

Keep `.env` private. Existing configuration and MFA encryption keys must be preserved. The local database uses trust authentication bound to loopback; this is development configuration. Production needs authenticated database access, HTTPS, protected persistent file storage and backups, and a working email delivery provider. The local PDF adapter supports opt-in `SDC_CHROMIUM_NO_SANDBOX=1` only inside an isolated development container. Do not use that mode for production deployment.

## Validation

```bash
npm test
# Use a SEPARATE empty database for integration tests, initialize its schema/migrations first:
DATABASE_URL=postgresql://sdc_dev@127.0.0.1:55432/vertex_workflows_test npm run db:init
TEST_DATABASE_URL=postgresql://sdc_dev@127.0.0.1:55432/vertex_workflows_test npm run test:integration
```

Integration tests write synthetic fixtures to that dedicated test database. They exercise HTTP, PostgreSQL, role isolation, stale health-profile writes, the browser visit-start button, invoice issuance, concurrent duplicate payments, settlements and job applications. Never point them at a clinic database. Chromium must be installed; `SDC_CHROMIUM` overrides its executable path.

## Connected workflows

- Patient account/health profile, appointments, visit history, notifications, invoices and approved report downloads.
- Doctor visits, clinical records, treatment plans, reports, professional settings, lab tracking and job applications.
- Clinic operations, staff memberships/permissions, inventory, lab orders, invoices and payments.
- Staff operational dashboards, scoped patient administration, invoicing and permitted lab delivery actions.
- Administration catalogs, users/statuses, clinics, reporting, permissions and settlements. Clinical and financial history is preserved; there is no destructive hard-delete control for completed work.

Financial mutations use transaction locks and persisted request receipts. Retrying an identical payment request does not create another payment. A request key cannot be reused for different parameters. Health-profile writes use a version to reject stale updates. All new form mutations require CSRF and server-side authorization.

## AI provider

The symptom-assistant adapter expects an OpenAI-compatible Chat Completions endpoint supporting JSON responses. Configure `AI_API_URL`, `AI_MODEL`, and `AI_PROVIDER_KEY` through secure environment settings. Do not put a key in source control or chat. The patient must consent before symptoms are sent. Without provider configuration the page explains that the service is unavailable and shows no fabricated result. Provider behavior is tested using an injected response; live operation remains unverified until a real provider is configured. This feature supplies preliminary information and does not replace a dentist's diagnosis.
