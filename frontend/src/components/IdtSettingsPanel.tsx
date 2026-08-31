export interface IdtCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  region: 'us' | 'eu';
}

interface Props {
  credentials: IdtCredentials;
  onChange: (next: IdtCredentials) => void;
}

/** IDT OligoAnalyzer credentials — five discrete fields, matching Oligool's
 * own storage shape exactly (per the rewrite plan's locked-in decision):
 * `idt_client_id`/`idt_client_secret`/`idt_username`/`idt_password`/
 * `idt_region` as separate `localStorage` keys (owned by `App.tsx`, which
 * is where the actual `localStorage` reads/writes happen — this component
 * is a plain controlled form over whatever state it's handed). Assembled
 * into one request object only at the point a `/idt/token` call is
 * actually built (`SelectedPrimerInfo`'s "Analyze with IDT" handler).
 * Never sent anywhere except IDT's own token endpoint. */
export default function IdtSettingsPanel({ credentials, onChange }: Props) {
  return (
    <details className="border border-slate-200 dark:border-slate-700 rounded-lg">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
        ⚙️ IDT OligoAnalyzer Credentials (optional)
      </summary>
      <div className="px-4 py-3 space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Stored only in this browser (never sent anywhere except IDT's own servers when you click "Analyze with IDT").
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Client ID</label>
            <input
              type="text"
              value={credentials.clientId}
              onChange={(e) => onChange({ ...credentials, clientId: e.target.value })}
              className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Client Secret</label>
            <input
              type="password"
              value={credentials.clientSecret}
              onChange={(e) => onChange({ ...credentials, clientSecret: e.target.value })}
              className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Username</label>
            <input
              type="text"
              value={credentials.username}
              onChange={(e) => onChange({ ...credentials, username: e.target.value })}
              className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Password</label>
            <input
              type="password"
              value={credentials.password}
              onChange={(e) => onChange({ ...credentials, password: e.target.value })}
              className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 dark:text-slate-400 mb-1">Region</label>
            <select
              value={credentials.region}
              onChange={(e) => onChange({ ...credentials, region: e.target.value as 'us' | 'eu' })}
              className="w-full rounded-md border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm text-sm px-2 py-1.5 border"
            >
              <option value="eu">EU (eu.idtdna.com)</option>
              <option value="us">US (www.idtdna.com)</option>
            </select>
          </div>
        </div>
      </div>
    </details>
  );
}
