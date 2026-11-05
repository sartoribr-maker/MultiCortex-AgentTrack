"use client";

import { useActionState } from "react";
import { devcoreLoginAction } from "../actions";

const inputClass =
  "w-full rounded-lg border border-[var(--dc-border)] bg-white px-3 py-2.5 text-base text-[var(--dc-text)] outline-none focus:border-[var(--dc-blue)] focus:ring-2 focus:ring-[var(--dc-blue)]/20";

export function DevcoreLoginForm() {
  const [state, action, pending] = useActionState(devcoreLoginAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm font-bold">
        E-mail
        <input key={state?.email} name="email" type="email" required autoComplete="email" defaultValue={state?.email} className={inputClass} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-bold">
        Senha
        <input name="password" type="password" required autoComplete="current-password" className={inputClass} />
      </label>
      {state?.message && (
        <p role="alert" className="rounded-lg bg-[#fdecef] px-3 py-2 text-sm text-[#a3122f]">
          {state.message}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-[var(--dc-navy)] px-4 py-2.5 text-base font-bold text-white transition hover:bg-[var(--dc-blue)] disabled:opacity-60"
      >
        {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
