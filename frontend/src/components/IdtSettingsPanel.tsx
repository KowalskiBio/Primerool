import Field from './ui/Field';
import TextInput from './ui/TextInput';
import Select from './ui/Select';
import type { IdtCredentials } from '../utils/idtCredentials';

interface Props {
  credentials: IdtCredentials;
  onChange: (next: IdtCredentials) => void;
}

/** IDT OligoAnalyzer account fields for the settings modal. A plain
 * controlled form - storage (encrypted, see `utils/idtCredentials`) is
 * owned by `App.tsx`. */
export default function IdtSettingsPanel({ credentials, onChange }: Props) {
  return (
    <div>
      <p className="mb-4 text-xs text-ink-faint">
        Stored encrypted in this browser. Used only to sign in to IDT when you click "Analyze with IDT" (relayed through this app's server, which doesn't keep them).
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
