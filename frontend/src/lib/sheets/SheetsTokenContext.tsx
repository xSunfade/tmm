import React, { createContext, useContext } from 'react';

export type SheetsTokenGetter = () => string | null;

const SheetsTokenContext = createContext<SheetsTokenGetter | null>(null);

export function SheetsTokenProvider({
  getToken,
  children
}: {
  getToken: SheetsTokenGetter;
  children: React.ReactNode;
}) {
  return (
    <SheetsTokenContext.Provider value={getToken}>
      {children}
    </SheetsTokenContext.Provider>
  );
}

export function useSheetsToken(): string | null {
  const getToken = useContext(SheetsTokenContext);
  return getToken?.() ?? null;
}
