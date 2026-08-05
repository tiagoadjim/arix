'use client';

import { BotIcon, MessageCircleIcon, StoreIcon } from 'lucide-react';
import type { Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/provider';
import { Button } from '@/components/ui/button';

export function WelcomeStep({
  uiLanguage,
  onPickLanguage,
  onStart,
}: {
  uiLanguage: Locale;
  onPickLanguage: (locale: Locale) => void;
  onStart: () => void;
}) {
  const { t } = useT();
  const bullets = [
    { Icon: StoreIcon, text: t.wizard.welcome.bulletStore },
    { Icon: BotIcon, text: t.wizard.welcome.bulletAi },
    { Icon: MessageCircleIcon, text: t.wizard.welcome.bulletWhatsapp },
  ];

  return (
    <div className="flex flex-col gap-8">
      <ul className="flex flex-col gap-3">
        {bullets.map(({ Icon, text }) => (
          <li key={text} className="flex items-start gap-3 rounded-lg border bg-card p-4">
            <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
            <span className="text-sm text-pretty">{text}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t.wizard.welcome.languagePrompt}</p>
        <div className="flex gap-2">
          <Button variant={uiLanguage === 'es' ? 'default' : 'outline'} onClick={() => onPickLanguage('es')}>
            Español
          </Button>
          <Button variant={uiLanguage === 'en' ? 'default' : 'outline'} onClick={() => onPickLanguage('en')}>
            English
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Button size="lg" className="w-fit" onClick={onStart}>
          {t.wizard.welcome.start}
        </Button>
        <p className="text-xs text-muted-foreground">{t.wizard.welcome.timeHint}</p>
      </div>
    </div>
  );
}
