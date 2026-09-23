import Field from './ui/Field';
import TextInput from './ui/TextInput';
import Select from './ui/Select';

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

/** IDT OligoAnalyzer credentials - five discrete fields, matching Oligool's
 * own storage shape exactly (per the rewrite plan's locked-in decision):
 * `idt_client_id`/`idt_client_secret`/`idt_username`/`idt_password`/
 * `idt_region` as separate `localStorage` keys (owned by `App.tsx`, which
 * is where the actual `localStorage` reads/writes happen - this component
 * is a plain controlled form over whatever state it's handed). Assembled
 * into one request object only at the point a `/idt/token` call is
 * actually built (`SelectedPrimerInfo`'s "Analyze with IDT" handler).
 * Never sent anywhere except IDT's own token endpoint. */
export default function IdtSettingsPanel({ credentials, onChange }: Props) {
  return (
    <div>
      <p className="mb-4 text-xs text-ink-faint">
        Stored only in this browser (never sent anywhere except IDT's own servers when you click "Analyze with IDT").
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Client ID">
          <TextInput
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={credentials.clientId}
            onChange={(e) => onChange({ ...credentials, clientId: e.target.value })}
          />
        </Field>
        <Field label="Client Secret">
          <TextInput
            type="password"
            autoComplete="off"
            value={credentials.clientSecret}
            onChange={(e) => onChange({ ...credentials, clientSecret: e.target.value })}
          />
        </Field>
        <Field label="Username">
          <TextInput
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={credentials.username}
            onChange={(e) => onChange({ ...credentials, username: e.target.value })}
          />
        </Field>
        <Field label="Password">
          <TextInput
            type="password"
            autoComplete="off"
            value={credentials.password}
            onChange={(e) => onChange({ ...credentials, password: e.target.value })}
          />
        </Field>
        <Field label="Region" className="max-w-64">
          <Select value={credentials.region} onChange={(e) => onChange({ ...credentials, region: e.target.value as 'us' | 'eu' })}>
            <option value="eu">EU (eu.idtdna.com)</option>
            <option value="us">US (www.idtdna.com)</option>
          </Select>
        </Field>
      </div>
    </div>
  );
}
