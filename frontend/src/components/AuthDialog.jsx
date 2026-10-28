import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import api, { apiErrorMessage } from '../services/api';

export default function AuthDialog({ mode, onClose, onSuccess, onSwitch }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    const isSignup = mode === 'signup';
    const payload = {
      email: form.get('email'),
      password: form.get('password'),
      ...(isSignup ? { display_name: form.get('display_name') } : {}),
    };

    try {
      const { data } = await api.post(`/auth/${isSignup ? 'signup' : 'login'}.php`, payload);
      onSuccess(data.token, data.user);
    } catch (requestError) {
      setError(apiErrorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <button className="icon-button dialog-close" type="button" aria-label="Close" onClick={onClose}>
          <X size={19} />
        </button>
        <span className="eyebrow">RAYN STREAM ACCOUNT</span>
        <h2 id="auth-title">{mode === 'signup' ? 'Join the screening room.' : 'Welcome back.'}</h2>
        <p className="dialog-copy">
          {mode === 'signup' ? 'Create your account to save your place.' : 'Sign in to continue to your account.'}
        </p>
        <form className="form-stack" onSubmit={submit}>
          {mode === 'signup' && (
            <label>
              Display name
              <input autoComplete="name" name="display_name" maxLength="120" required />
            </label>
          )}
          <label>
            Email
            <input autoComplete="email" name="email" type="email" maxLength="254" required />
          </label>
          <label>
            Password
            <input
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              name="password"
              type="password"
              minLength={mode === 'signup' ? 8 : undefined}
              required
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary form-submit" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <p className="switch-auth">
          {mode === 'signup' ? 'Already have an account?' : 'New to RAYN STREAM?'}{' '}
          <button className="text-button" type="button" onClick={onSwitch}>
            {mode === 'signup' ? 'Sign in' : 'Create account'}
          </button>
        </p>
      </section>
    </div>
  );
}