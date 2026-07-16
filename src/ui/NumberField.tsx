import { useEffect, useState } from 'react';

/**
 * Champ numérique qui laisse taper.
 *
 * Un `<input type="number">` lié à un nombre est infernal : on efface le contenu, la valeur
 * repasse à 0, le 0 se réaffiche aussitôt, et il faut aller placer le curseur devant pour
 * saisir. Ici la frappe vit dans une chaîne libre — le champ peut rester vide le temps de
 * la saisie — et la valeur n'est remontée que quand elle est réellement valide.
 */
export default function NumberField({
  value,
  onChange,
  min = 0,
  max,
  step,
  suffix,
  placeholder,
  title,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
  title?: string;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);

  // Tant qu'on tape, la valeur du parent ne doit pas réécrire le champ sous les doigts.
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);

  const commit = (raw: string) => {
    const v = parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(v)) { setText(String(value)); return; } // vide ou illisible : on rend la main
    let out = v;
    if (min != null) out = Math.max(min, out);
    if (max != null) out = Math.min(max, out);
    setText(String(out));
    if (out !== value) onChange(out);
  };

  return (
    <span className={`num-field ${className ?? ''}`}>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        title={title}
        placeholder={placeholder}
        onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.,]/g, ''))}
        onBlur={(e) => { setEditing(false); commit(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(e.currentTarget.value); e.currentTarget.blur(); }
          if (e.key === 'Escape') { setText(String(value)); e.currentTarget.blur(); }
          // Les flèches restent utiles pour ajuster au clavier.
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const cur = parseFloat(e.currentTarget.value.replace(',', '.'));
            const base = Number.isFinite(cur) ? cur : value;
            const d = (step ?? 1) * (e.key === 'ArrowUp' ? 1 : -1);
            const next = Math.round((base + d) * 1000) / 1000;
            commit(String(next));
          }
        }}
      />
      {suffix && <em>{suffix}</em>}
    </span>
  );
}
