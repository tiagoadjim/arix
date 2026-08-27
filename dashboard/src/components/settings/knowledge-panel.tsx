'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PencilIcon, Trash2Icon, LinkIcon } from 'lucide-react';
import { api, apiErrorMessage } from '@/lib/api';
import type { KnowledgeEntry } from '@/lib/types';
import { interpolate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Knowledge base tab — the operator's side of the `knowledge` skill.
 *
 * Everything here becomes something the agent may state as fact to a customer,
 * so the list is the review surface: an entry learned from the website scan is
 * badged with its source so it can be checked against the page it came from.
 */

function parseTags(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function KnowledgePanel() {
  const { t } = useT();
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [filter, setFilter] = useState('');

  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      setEntries((await api.knowledge()).entries);
    } catch {
      // Transient — keep the last known list on screen rather than blanking it.
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    if (!entries) return null;
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      `${entry.question} ${entry.answer} ${entry.tags.join(' ')}`.toLowerCase().includes(needle),
    );
  }, [entries, filter]);

  function resetForm() {
    setQuestion('');
    setAnswer('');
    setTags('');
    setEditing(null);
  }

  function startEdit(entry: KnowledgeEntry) {
    setEditing(entry);
    setQuestion(entry.question);
    setAnswer(entry.answer);
    setTags(entry.tags.join(', '));
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || !answer.trim()) {
      toast.error(t.settings.knowledgeIncomplete);
      return;
    }
    setSaving(true);
    try {
      const input = { question: question.trim(), answer: answer.trim(), tags: parseTags(tags) };
      if (editing) {
        await api.updateKnowledge(editing.id, input);
        toast.success(t.settings.knowledgeUpdated);
      } else {
        await api.createKnowledge(input);
        toast.success(t.settings.knowledgeCreated);
      }
      resetForm();
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteKnowledge(deleteTarget.id);
      toast.success(t.settings.knowledgeDeleted);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.common.error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t.settings.knowledgeTitle}</CardTitle>
          <CardDescription>{t.settings.knowledgeDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-question">{t.settings.knowledgeQuestion}</Label>
              <Input
                id="kb-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={t.settings.knowledgeQuestionPlaceholder}
                maxLength={500}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-answer">{t.settings.knowledgeAnswer}</Label>
              <Textarea
                id="kb-answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={t.settings.knowledgeAnswerPlaceholder}
                rows={4}
                maxLength={5000}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-tags">{t.settings.knowledgeTags}</Label>
              <Input
                id="kb-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder={t.settings.knowledgeTagsPlaceholder}
              />
              <p className="text-xs text-muted-foreground">{t.settings.knowledgeTagsHint}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={saving}>
                {saving
                  ? editing
                    ? t.settings.knowledgeSaving
                    : t.settings.knowledgeAdding
                  : editing
                    ? t.settings.knowledgeSave
                    : t.settings.knowledgeAdd}
              </Button>
              {editing && (
                <Button type="button" variant="ghost" onClick={resetForm} disabled={saving}>
                  {t.settings.knowledgeCancel}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3">
          <CardTitle>
            {entries ? interpolate(t.settings.knowledgeCount, { count: entries.length }) : ' '}
          </CardTitle>
          {entries && entries.length > 0 && (
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t.settings.knowledgeFilter}
              aria-label={t.settings.knowledgeFilter}
            />
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {entries === null && (
            <>
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </>
          )}
          {entries?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t.settings.knowledgeEmpty}</p>
          )}
          {entries !== null && entries.length > 0 && visible?.length === 0 && (
            <p className="text-sm text-muted-foreground">{t.settings.knowledgeNoMatches}</p>
          )}
          {visible?.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium break-words">{entry.question}</p>
                <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap">
                  {entry.answer}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {entry.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                    </Badge>
                  ))}
                  {entry.source_url && (
                    <a
                      href={entry.source_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2"
                    >
                      <LinkIcon className="size-3" aria-hidden />
                      {t.settings.knowledgeSource}
                    </a>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => startEdit(entry)}
                  aria-label={`${t.settings.knowledgeEdit}: ${entry.question}`}
                  title={t.settings.knowledgeEdit}
                >
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDeleteTarget(entry)}
                  aria-label={`${t.settings.knowledgeDelete}: ${entry.question}`}
                  title={t.settings.knowledgeDelete}
                >
                  <Trash2Icon />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.settings.knowledgeDeleteTitle}</DialogTitle>
            <DialogDescription>{t.settings.knowledgeDeleteBody}</DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium break-words">{deleteTarget?.question}</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" disabled={deleting}>
                {t.settings.knowledgeCancel}
              </Button>
            </DialogClose>
            <Button variant="destructive" onClick={onDelete} disabled={deleting}>
              {deleting ? t.settings.knowledgeDeleting : t.settings.knowledgeDelete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
