export function SummaryPill({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "amber" | "red";
}) {
  return (
    <div
      className={`min-w-0 rounded-none border bg-panel px-4 py-3 shadow-none ${tone === "red" ? "border-crit/25 text-crit" : tone === "amber" ? "border-warn/25 text-warn" : "border-line text-text"}`}
    >
      <p className="text-[11px] font-normal uppercase tracking-[0.14em] text-dim">
        {label}
      </p>
      <p
        className="mt-1 whitespace-normal break-words text-[15px] font-medium leading-5"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}
