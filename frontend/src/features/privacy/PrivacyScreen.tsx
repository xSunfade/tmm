import { useEffect, useRef } from 'react';
import { navigateToRoute } from '../../app/routing';

export function PrivacyScreen() {
  const retentionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.location.hash !== '#data-retention') return;
    const el = document.getElementById('data-retention') ?? retentionRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-10 px-4 py-8 text-slate-200">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-white">Privacy &amp; Data Retention</h1>
        <button
          type="button"
          className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          onClick={() => navigateToRoute('settings')}
        >
          Back to Settings
        </button>
      </div>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-100">Privacy Policy (TMM)</h2>
        <p className="text-xs text-slate-500">Effective date: 2026-02-09 · Version: 2026-02-09</p>

        <h3 className="text-sm font-medium text-slate-200">1. What we collect</h3>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Account and transaction data retrieved through Plaid (when enabled by user).</li>
          <li>Account linkage metadata and sync history.</li>
          <li>Authentication/profile metadata needed to operate the product.</li>
          <li>Operational logs and diagnostics.</li>
        </ul>

        <h3 className="text-sm font-medium text-slate-200">2. How we use data</h3>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Provide account sync and cash-flow tracking features.</li>
          <li>Run planning and simulation features.</li>
          <li>Maintain system reliability, security, and fraud detection.</li>
          <li>Comply with legal obligations.</li>
        </ul>

        <h3 className="text-sm font-medium text-slate-200">3. Data sharing</h3>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Plaid is used to access financial account data.</li>
          <li>Supabase is used for authentication and data storage.</li>
          <li>Hosting and monitoring providers process operational data for service delivery.</li>
        </ul>

        <h3 className="text-sm font-medium text-slate-200">4. User controls</h3>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Users can disconnect linked accounts.</li>
          <li>Users can request deletion of their account and associated data from Settings.</li>
          <li>Consent is captured before Plaid Link is initiated.</li>
        </ul>

        <h3 className="text-sm font-medium text-slate-200">5. Security</h3>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Data in transit is protected by TLS.</li>
          <li>Sensitive tokens are encrypted at rest.</li>
          <li>Access is restricted by least-privilege controls and MFA on critical systems.</li>
        </ul>
      </section>

      <section id="data-retention" ref={retentionRef} className="scroll-mt-8 space-y-4">
        <h2 className="text-lg font-semibold text-slate-100">Data Retention and Deletion Policy (TMM)</h2>
        <p className="text-xs text-slate-500">Version: 1.0 · Review cadence: Quarterly</p>

        <h3 className="text-sm font-medium text-slate-200">1. Retention schedule</h3>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Plaid transactions: retained until user deletes account or disconnects data source.</li>
          <li>Account metadata (accounts, plaid_tokens, plaid_item_status): retained while connection is active.</li>
          <li>Webhook events: operational retention target 180 days.</li>
          <li>Sync run telemetry: operational retention target 180 days.</li>
          <li>Logs: retention determined by logging platform policy (default target 90 days unless legally required otherwise).</li>
        </ul>

        <h3 className="text-sm font-medium text-slate-200">2. User-initiated deletion</h3>
        <p className="text-sm text-slate-400">When you confirm deletion using the in-app flow:</p>
        <ol className="list-inside list-decimal space-y-1 text-sm text-slate-400">
          <li>TMM calls Plaid /item/remove for linked items where access is available.</li>
          <li>TMM deletes financial/account data and integration metadata.</li>
          <li>TMM deletes the auth user record and related profile/onboarding data.</li>
        </ol>

        <h3 className="text-sm font-medium text-slate-200">3. Evidence and auditability</h3>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-400">
          <li>Deletion request is recorded in data_deletion_requests.</li>
          <li>Consent records are retained in privacy_consents until account deletion.</li>
          <li>Deletion outcomes are logged for operational verification.</li>
        </ul>
      </section>

      <section className="border-t border-slate-800 pt-6 text-sm text-slate-500">
        <p>Security and privacy requests: see your organization’s security contacts or support channel.</p>
      </section>
    </div>
  );
}
