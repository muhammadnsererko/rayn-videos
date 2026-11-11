import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import api, { apiErrorMessage } from '../services/api';

export default function VjManagementDialog({ onClose, onChanged }) {
  const [vjs, setVjs] = useState([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const loadVjs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/vjs.php', { params: { include_inactive: 'true' } });
      setVjs(data.vjs);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVjs();
  }, [loadVjs]);

  async function addVj(event) {
    event.preventDefault();
    setError('');
    try {
      await api.post('/vjs.php', { name: newName });
      setNewName('');
      await loadVjs();
      onChanged();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    }
  }

  async function renameVj(vj) {
    const name = window.prompt('New VJ name', vj.name);
    if (name === null || name.trim() === '' || name.trim() === vj.name) return;
    setBusyId(vj.id);
    setError('');
    try {
      await api.put('/vjs.php', { id: vj.id, name });
      await loadVjs();
      onChanged();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusyId(null);
    }
  }

  async function deactivateVj(vj) {
    if (!window.confirm(`Deactivate ${vj.name}? Existing movie credits will be kept.`)) return;
    setBusyId(vj.id);
    setError('');
    try {
      await api.delete('/vjs.php', { data: { id: vj.id } });
      await loadVjs();
      onChanged();
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog vj-dialog" role="dialog" aria-modal="true" aria-labelledby="vj-title">
        <button className="icon-button dialog-close" type="button" aria-label="Close VJ management" onClick={onClose}>
          <X size={19} />
        </button>
        <span className="eyebrow">LIBRARY MANAGEMENT</span>
        <h2 id="vj-title">Manage VJs</h2>
        <form className="form-row vj-add-form" onSubmit={addVj}>
          <label>
            Add VJ
            <input
              value={newName}
              maxLength="120"
              onChange={(event) => setNewName(event.target.value)}
              required
            />
          </label>
          <button className="button button-primary" type="submit">Add</button>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
        {loading ? <p className="dialog-copy">Loading VJs…</p> : (
          <ul className="vj-list">
            {vjs.map((vj) => (
              <li key={vj.id} className={!vj.is_active ? 'vj-inactive' : ''}>
                <span>{vj.name}{!vj.is_active && <small>Inactive</small>}</span>
                <div>
                  <button className="button button-quiet" type="button" disabled={busyId === vj.id} onClick={() => renameVj(vj)}>
                    Rename
                  </button>
                  {vj.is_active && (
                    <button className="button button-quiet" type="button" disabled={busyId === vj.id} onClick={() => deactivateVj(vj)}>
                      Deactivate
                    </button>
                  )}
                </div>
              </li>
            ))}
            {vjs.length === 0 && <li className="dialog-copy">No VJs have been added.</li>}
          </ul>
        )}
      </section>
    </div>
  );
}
