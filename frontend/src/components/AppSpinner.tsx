import { useId } from 'react';

/**
 * Shared loading spinner used for Sheets sync and MFA verification.
 * Uses unique IDs per instance so multiple spinners can exist in the DOM.
 */
export function AppSpinner({ className }: { className?: string }) {
  const p = useId().replace(/:/g, '_') + '_';
  const p1 = p + '1';
  const p2 = p + '2';
  const p3 = p + '3';
  const p4 = p + '4';
  const p5 = p + '5';
  const p6 = p + '6';
  const p7 = p + '7';
  const p8 = p + '8';
  const p9 = p + '9';
  const p10 = p + '10';
  const p11 = p + '11';
  const p12 = p + '12';

  return (
    <svg fill="hsl(228, 97%, 42%)" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" className={className ?? 'h-14 w-14'}>
      <rect x="1" y="1" rx="1" width="10" height="10">
        <animate id={p1} begin={`0;${p12}.end`} attributeName="x" dur="0.2s" values="1;13" fill="freeze" />
        <animate id={p2} begin={`${p9}.end`} attributeName="y" dur="0.2s" values="1;13" fill="freeze" />
        <animate id={p3} begin={`${p10}.end`} attributeName="x" dur="0.2s" values="13;1" fill="freeze" />
        <animate id={p4} begin={`${p11}.end`} attributeName="y" dur="0.2s" values="13;1" fill="freeze" />
      </rect>
      <rect x="1" y="13" rx="1" width="10" height="10">
        <animate id={p5} begin={`${p1}.end`} attributeName="y" dur="0.2s" values="13;1" fill="freeze" />
        <animate id={p6} begin={`${p2}.end`} attributeName="x" dur="0.2s" values="1;13" fill="freeze" />
        <animate id={p7} begin={`${p3}.end`} attributeName="y" dur="0.2s" values="1;13" fill="freeze" />
        <animate id={p8} begin={`${p4}.end`} attributeName="x" dur="0.2s" values="13;1" fill="freeze" />
      </rect>
      <rect x="13" y="13" rx="1" width="10" height="10">
        <animate id={p9} begin={`${p5}.end`} attributeName="x" dur="0.2s" values="13;1" fill="freeze" />
        <animate id={p10} begin={`${p6}.end`} attributeName="y" dur="0.2s" values="13;1" fill="freeze" />
        <animate id={p11} begin={`${p7}.end`} attributeName="x" dur="0.2s" values="1;13" fill="freeze" />
        <animate id={p12} begin={`${p8}.end`} attributeName="y" dur="0.2s" values="1;13" fill="freeze" />
      </rect>
    </svg>
  );
}
