import { useState } from 'react';
import { useStore } from '../store';
export default function AuthScreen() {
  const [register, setRegister] = useState(false);
  const state = useStore();
  return (
    <div className="min-h-screen bg-canvas text-ink flex items-center justify-center">
      <form
        className="bg-panel border border-line rounded-[20px] p-8 w-96 space-y-4 shadow-panel"
        onSubmit={(event) => {
          event.preventDefault();
          const data = Object.fromEntries(new FormData(event.currentTarget));
          void state.authenticate(register ? 'register' : 'login', data);
        }}
      >
        <h1 className="text-xl font-semibold">TeamWeave</h1>
        <p className="text-muted text-sm">
          {register
            ? 'Create your company workspace'
            : 'Sign in to your company'}
        </p>
        {register && (
          <>
            <input
              name="name"
              required
              placeholder="Your name"
              className="form-input"
            />
            <input
              name="organizationName"
              required
              placeholder="Company name"
              className="form-input"
            />
          </>
        )}
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="Email"
          className="form-input"
        />
        <input
          name="password"
          type="password"
          autoComplete={register ? 'new-password' : 'current-password'}
          minLength={register ? 10 : undefined}
          required
          placeholder="Password"
          className="form-input"
        />
        {state.error && (
          <p role="alert" className="text-err text-xs">
            {state.error}
          </p>
        )}
        <button disabled={state.loading} className="action-button w-full">
          {register ? 'Register company' : 'Log in'}
        </button>
        <button
          type="button"
          className="text-muted text-xs"
          onClick={() => {
            setRegister(!register);
            useStore.setState({ error: null });
          }}
        >
          {register ? 'Already have an account? Log in' : 'Register a company'}
        </button>
      </form>
    </div>
  );
}
