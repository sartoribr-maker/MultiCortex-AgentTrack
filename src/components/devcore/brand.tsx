import Image from "next/image";

export function BrandMark() {
  return (
    <span className="flex items-center gap-2.5">
      <Image src="/brand/mark.png" alt="" width={32} height={32} className="h-8 w-8 shrink-0" priority />
      <span className="leading-tight">
        <span className="block text-[17px] font-bold tracking-tight">MultiCortex</span>
        <span className="block text-xs font-bold uppercase tracking-[0.14em] text-[var(--dc-orange)]">DevCore Monitor</span>
      </span>
    </span>
  );
}
