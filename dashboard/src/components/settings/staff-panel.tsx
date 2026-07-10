'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KeyRoundIcon, Trash2Icon } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import type { Agent, StaffRole } from '@/lib/types';
import { interpolate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Staff (agentes) management tab — ported 1:1 from the old `(panel)/agentes`
 * route: list, create, delete (now a confirm Dialog instead of `confirm()`),
 * reset password (now a Dialog with password+confirm instead of `prompt()`).
 * Self/last-admin guards are server-enforced (api/server.ts) and surfaced
 * here via toast, same as any other API error. */
export function StaffPanel() {
  const { t } = useT();
  const [agents, setAgents] = useState<Agent[] | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRole>('agent');
  const [creating, setCreating] = useState(false);
  const [roleBusy, setRoleBusy] = useState<Record<string, boolean>>({});

  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [resetTarget, setResetTarget] = useState<Agent | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [resetting, setResetting] = useState(false);

  async function load() {
    try {
      setAgents(await api.staff());
    } catch {
      // transient — keep the last known list on screen
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      toast.error(t.settings.staff.passwordTooShort);
      return;
    }
    setCreating(true);
    try {
      await api.createStaff({ name: name.trim(), email: email.trim(), password, role });
      setName('');
      setEmail('');
      setPassword('');
      setRole('agent');
      toast.success(t.settings.staff.createdToast);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setCreating(false);
    }
  }

  async function handleRoleChange(agent: Agent, nextRole: StaffRole) {
    if (agent.role === nextRole) return;
    setRoleBusy((current) => ({ ...current, [agent.id]: true }));
    try {
      const updated = await api.updateStaffRole(agent.id, nextRole);
      setAgents((current) => current?.map((item) => (item.id === agent.id ? updated : item)) ?? current);
      toast.success(t.settings.staff.roleChangedToast);
    } catch (error) {
      toast.error(apiErrorMessage(error, t, t.common.error));
    } finally {
      setRoleBusy((current) => ({ ...current, [agent.id]: false }));
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteStaff(deleteTarget.id);
      toast.success(t.settings.staff.deletedToast);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setDeleting(false);
    }
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    if (resetPassword.length < 8) {
      toast.error(t.settings.staff.passwordTooShort);
      return;
    }
    if (resetPassword !== resetConfirm) {
      toast.error(t.settings.staff.passwordMismatch);
      return;
    }
    setResetting(true);
    try {
      await api.resetStaffPassword(resetTarget.id, resetPassword);
      toast.success(interpolate(t.settings.staff.resetSuccessToast, { email: resetTarget.email }));
      setResetTarget(null);
      setResetPassword('');
      setResetConfirm('');
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">{t.settings.staff.title}</h2>
        <p className="text-sm text-muted-foreground">{t.settings.staff.description}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.staff.newTitle}</CardTitle>
          <CardDescription>{t.settings.staff.newHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handleCreate(e)} className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor="staff-name">{t.settings.staff.nameLabel}</Label>
              <Input id="staff-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label htmlFor="staff-email">{t.settings.staff.emailLabel}</Label>
              <Input id="staff-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label htmlFor="staff-password">{t.settings.staff.passwordLabel}</Label>
              <Input
                id="staff-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor="staff-role">{t.settings.staff.roleLabel}</Label>
              <Select value={role} onValueChange={(value) => setRole(value as StaffRole)} disabled={creating}>
                <SelectTrigger id="staff-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="agent">{t.settings.staff.roleAgent}</SelectItem>
                  <SelectItem value="admin">{t.settings.staff.roleAdmin}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={creating}>
              {creating ? t.settings.staff.creating : t.settings.staff.createButton}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.staff.listTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {agents === null && (
            <>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </>
          )}
          {agents !== null && agents.length === 0 && <p className="text-sm text-muted-foreground">{t.settings.staff.emptyList}</p>}
          {agents?.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">{a.name || '—'}</p>
                <p className="text-xs text-muted-foreground">{a.email}</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Select
                  value={a.role}
                  onValueChange={(value) => void handleRoleChange(a, value as StaffRole)}
                  disabled={roleBusy[a.id]}
                >
                  <SelectTrigger size="sm" className="w-36" aria-label={`${t.settings.staff.roleLabel}: ${a.name || a.email}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">{t.settings.staff.roleAgent}</SelectItem>
                    <SelectItem value="admin">{t.settings.staff.roleAdmin}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setResetTarget(a);
                    setResetPassword('');
                    setResetConfirm('');
                  }}
                >
                  <KeyRoundIcon className="size-3.5" />
                  {t.settings.staff.resetPasswordButton}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setDeleteTarget(a)}>
                  <Trash2Icon className="size-3.5" />
                  {t.settings.staff.deleteButton}
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.settings.staff.deleteDialogTitle}</DialogTitle>
            <DialogDescription>
              {deleteTarget && interpolate(t.settings.staff.deleteDialogDescription, { name: deleteTarget.name || deleteTarget.email })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t.common.cancel}
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? t.common.deleting : t.settings.staff.deleteConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resetTarget !== null} onOpenChange={(open) => !open && setResetTarget(null)}>
        <DialogContent>
          <form onSubmit={(e) => void handleReset(e)}>
            <DialogHeader>
              <DialogTitle>{t.settings.staff.resetDialogTitle}</DialogTitle>
              <DialogDescription>
                {resetTarget && interpolate(t.settings.staff.resetDialogDescription, { name: resetTarget.name || resetTarget.email })}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3 py-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reset-password">{t.settings.staff.newPasswordLabel}</Label>
                <Input
                  id="reset-password"
                  type="password"
                  autoComplete="new-password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reset-confirm">{t.settings.staff.confirmPasswordLabel}</Label>
                <Input
                  id="reset-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  required
                />
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t.common.cancel}
                </Button>
              </DialogClose>
              <Button type="submit" disabled={resetting}>
                {resetting ? t.common.saving : t.settings.staff.resetSubmit}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
