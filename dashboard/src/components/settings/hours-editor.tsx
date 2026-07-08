'use client';

import { useT } from '@/lib/i18n/provider';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { crossesMidnight, hhmmToMinutes, minutesToHHMM, type Schedule, type Window } from '@/lib/hours';

interface HoursEditorProps {
  value: Schedule;
  onChange: (value: Schedule) => void;
  disabled?: boolean;
}

const DEFAULT_OPEN = '11:00';
const DEFAULT_CLOSE = '17:00';

/** Weekly delivery-hours editor — one row per weekday (index 0 = Sunday,
 * matching server/src/agent/hours.ts's Schedule exactly). Each row is a
 * closed switch + open/close time inputs + a "closes next day" switch that
 * adds 1440 minutes to the close value, so `[660, 1620]` round-trips as
 * "11:00 → 03:00 (next day)" exactly like the server engine expects. */
export function HoursEditor({ value, onChange, disabled }: HoursEditorProps) {
  const { t } = useT();

  function updateDay(index: number, next: Window | null) {
    const copy = value.slice() as (Window | null)[];
    copy[index] = next;
    onChange(copy);
  }

  return (
    <div className="flex flex-col gap-2">
      {t.time.weekdays.map((label, index) => {
        const window = value[index] ?? null;
        const closed = window === null;
        const nextDay = crossesMidnight(window);
        const openStr = window ? minutesToHHMM(window[0]) : DEFAULT_OPEN;
        const closeStr = window ? minutesToHHMM(window[1]) : DEFAULT_CLOSE;

        const setWindow = (openInput: string, closeInput: string, nextDayInput: boolean) =>
          updateDay(index, [hhmmToMinutes(openInput), hhmmToMinutes(closeInput) + (nextDayInput ? 1440 : 0)]);

        return (
          <div
            key={index}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-muted/40 px-3 py-2.5"
          >
            <span className="w-24 shrink-0 text-sm font-medium capitalize">{label}</span>

            <Label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                size="sm"
                checked={!closed}
                disabled={disabled}
                onCheckedChange={(checked) => (checked ? setWindow(openStr, closeStr, nextDay) : updateDay(index, null))}
              />
              {closed ? t.settings.business.hoursClosedLabel : t.settings.business.hoursOpenLabel}
            </Label>

            {!closed && (
              <>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor={`hours-open-${index}`} className="text-xs text-muted-foreground">
                    {t.settings.business.hoursOpenLabel}
                  </Label>
                  <Input
                    id={`hours-open-${index}`}
                    type="time"
                    className="w-28"
                    value={openStr}
                    disabled={disabled}
                    onChange={(e) => setWindow(e.target.value, closeStr, nextDay)}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <Label htmlFor={`hours-close-${index}`} className="text-xs text-muted-foreground">
                    {t.settings.business.hoursCloseLabel}
                  </Label>
                  <Input
                    id={`hours-close-${index}`}
                    type="time"
                    className="w-28"
                    value={closeStr}
                    disabled={disabled}
                    onChange={(e) => setWindow(openStr, e.target.value, nextDay)}
                  />
                </div>
                <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Switch
                    size="sm"
                    checked={nextDay}
                    disabled={disabled}
                    onCheckedChange={(checked) => setWindow(openStr, closeStr, checked)}
                  />
                  {t.settings.business.hoursNextDayLabel}
                </Label>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
