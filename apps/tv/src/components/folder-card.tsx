interface FolderCardProps {
  name: string;
  subtitle?: string;
  focused: boolean;
  program?: boolean;
  hero?: boolean;
  onSelect?: () => void;
}

export function FolderCard({ name, subtitle, focused, program = false, hero = false, onSelect }: FolderCardProps) {
  return (
    <button
      type="button"
      className={`tv-card folder-card${program ? " program-card" : ""}${hero ? " is-hero" : ""}${focused ? " is-focused" : ""}`}
      aria-label={`${name}, ${program ? "program" : "folder"}`}
      data-testid={program ? "program-card" : undefined}
      onClick={onSelect}
      tabIndex={focused ? 0 : -1}
    >
      <span className="card-visual folder-art" aria-hidden="true">
        <ProgramStockArt program={program} name={name} />
        {program && <span className="program-frame-mark"><i /><i /></span>}
      </span>
      <span className="card-copy">
        <strong>{name}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
    </button>
  );
}

function ProgramStockArt({ program, name }: { program: boolean; name: string }) {
  return (
    <span className={`program-stock-art${program ? " is-program" : ""}`}>
      <span className="stock-rule" />
      <b>{program ? initials(name) : "Folder"}</b>
      <span className="stock-copy">{program ? "Household screening program" : "Cloudframe collection"}</span>
    </span>
  );
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word.charAt(0)).join("").toUpperCase();
}
