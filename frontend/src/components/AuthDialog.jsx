import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import api, { apiErrorMessage } from '../services/api';

export default function AuthDialog({ mode, onClose, onSuccess, onSwitch, onForgotPassword, resetToken = '' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetComplete, setResetComplete] = useState(false);

  const isSignup = mode === 'signup';
  const isResetRequest = mode === 'reset-request';
  const isReset = mode === 'reset';

  useEffect(() => {
    setError('');
    setNotice('');
    setResetComplete(false);
  }, [mode]);

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
    setNotice('');
    const form = new FormData(event.currentTarget);

    try {
      if (isResetRequest) {
        await api.post('/auth/password-reset-request.php', { email: form.get('email') });
        setNotice('If an account exists for that email, a reset link will be sent.');
      } else if (isReset) {
        const password = form.get('password');
        if (password !== form.get('confirm_password')) {
          setError('Passwords do not match.');
          return;
        }
        await api.post('/auth/password-reset-complete.php', { token: resetToken, password });
        setResetComplete(true);
        setNotice('Your password has been reset. You can now sign in.');
      } else {
        const payload = {
          email: form.get('email'),
          password: form.get('password'),
          ...(isSignup ? { display_name: form.get('display_name') } : {}),
        };
        const { data } = await api.post(`/auth/${isSignup ? 'signup' : 'login'}.php`, payload);
        onSuccess(data.token, data.user);
      }
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
        <h2 id="auth-title">
          {isSignup ? 'Join the screening room.' : isResetRequest || isReset ? 'Reset your password.' : 'Welcome back.'}
        </h2>
        <p className="dialog-copy">
          {isSignup
            ? 'Create your account to save your place.'
            : isResetRequest
              ? 'Enter your account email and we’ll send a reset link if it matches an account.'
              : isReset
                ? 'Choose a new password for your account.'
                : 'Sign in to continue to your account.'}
        </p>
        {resetComplete ? (
          <div className="form-stack">
            <p className="form-success" role="status">{notice}</p>
            <button className="button button-primary form-submit" type="button" onClick={onSwitch}>Back to sign in</button>
          </div>
        ) : (
          <>
            <form className="form-stack" onSubmit={submit}>
              {isSignup && (
                <label>
                  Display name
                  <input autoComplete="name" name="display_name" maxLength="120" required />
                </label>
              )}
              {(mode === 'login' || isSignup || isResetRequest) && (
                <label>
                  Email
                  <input autoComplete="email" name="email" type="email" maxLength="254" required />
                </label>
              )}
              {!isResetRequest && (
                <label>
                  {isReset ? 'New password' : 'Password'}
                  <input
                    autoComplete={isSignup || isReset ? 'new-password' : 'current-password'}
                    name="password"
                    type="password"
                    minLength={isSignup || isReset ? 8 : undefined}
                    maxLength={4096}
                    required
                  />
                </label>
              )}
              {isReset && (
                <label>
                  Confirm new password
                  <input autoComplete="new-password" name="confirm_password" type="password" minLength="8" maxLength="4096" required />
                </label>
              )}
              {error && <p className="form-error" role="alert">{error}</p>}
              {notice && <p className="form-success" role="status">{notice}</p>}
              <button className="button button-primary form-submit" type="submit" disabled={busy}>
                {busy
                  ? 'Please wait…'
                  : isSignup
                    ? 'Create account'
                    : isResetRequest
                      ? 'Send reset link'
                      : isReset
                        ? 'Update password'
                        : 'Sign in'}
              </button>
            </form>
            {mode === 'login' && (
              <p className="forgot-password">
                <button className="text-button" type="button" onClick={onForgotPassword}>Forgot password?</button>
              </p>
            )}
            <p className="switch-auth">
              {mode === 'signup'
                ? 'Already have an account?'
                : isResetRequest || isReset
                  ? 'Remembered your password?'
                  : 'New to RAYN STREAM?'}{' '}
              <button className="text-button" type="button" onClick={onSwitch}>
                {mode === 'signup' ? 'Sign in' : isResetRequest || isReset ? 'Back to sign in' : 'Create account'}
              </button>
            </p>
          </>
        )}
      </section>
    </div>
  );
}