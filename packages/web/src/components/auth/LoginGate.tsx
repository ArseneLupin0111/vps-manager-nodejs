import { type FormEvent } from "react";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function AuthLoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-ink text-dim">
      <div className="border border-line bg-panel px-6 py-5 text-[13px]">
        Checking dashboard access...
      </div>
    </main>
  );
}

export function LoginGate({
  password,
  busy,
  message,
  onPasswordChange,
  onSubmit,
}: {
  password: string;
  busy: boolean;
  message?: string;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="grid min-h-screen place-items-center bg-ink px-4 py-8 text-text">
      <section className="w-full max-w-sm border border-line bg-panel p-6 sm:p-7">
        <div className="mb-5">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center border border-line bg-raised text-[11px] font-semibold text-signal">
              FS
            </span>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-dim">
              Secure local console
            </p>
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-text">
            Unlock FlexServer
          </h1>
          <p className="mt-2 text-[13px] leading-6 text-dim">
            Enter the dashboard password. The password is verified server-side
            against the stored credential and is never stored in browser
            storage.
          </p>
        </div>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="dashboard-password" className="text-text">
              Dashboard password
            </Label>
            <Input
              id="dashboard-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="Enter password"
              autoFocus
            />
          </div>
          {message ? (
            <Alert variant="destructive" className="px-3 py-2 text-sm">
              {message}
            </Alert>
          ) : null}
          <Button type="submit" disabled={busy} className="h-10 w-full">
            {busy ? "Verifying..." : "Enter dashboard"}
          </Button>
        </form>
      </section>
    </main>
  );
}
