/**
 * Finnhub ticker search API.
 * Used for searching stock/crypto symbols in Ticker mode.
 */

export type TickerSearchResult = {
  symbol: string;
  description: string;
};

type FinnhubQuoteResponse = {
  c?: number;
};

/**
 * Search for ticker symbols via Finnhub API.
 * @param query - Search query (e.g. "AAPL", "SPY", "BTC")
 * @param apiKey - Finnhub API key
 * @returns Array of { symbol, description }, or empty array on error
 */
export async function searchTickers(
  query: string,
  apiKey: string
): Promise<TickerSearchResult[]> {
  const q = query.trim();
  if (!q || !apiKey.trim()) {
    return [];
  }

  try {
    const url = `https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 429) {
        console.warn('[finnhub] Rate limit hit for ticker search');
        return [];
      }
      if (res.status === 401 || res.status === 403) {
        console.warn('[finnhub] API key invalid or expired');
        return [];
      }
      return [];
    }

    const data = (await res.json()) as { result?: Array<{ symbol?: string; description?: string }> };
    const items = (data.result || []).slice(0, 10);
    return items.map((it) => ({
      symbol: it.symbol || '',
      description: it.description || ''
    }));
  } catch (e) {
    console.warn('[finnhub] Ticker search failed:', e);
    return [];
  }
}

/**
 * Fetch current live price for a ticker symbol.
 * @param symbol - Ticker symbol (e.g. "AAPL")
 * @param apiKey - Finnhub API key
 * @returns Current quote price, or null on error
 */
export async function fetchQuote(symbol: string, apiKey: string): Promise<number | null> {
  const sym = symbol.trim();
  if (!sym || !apiKey.trim()) {
    return null;
  }

  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[finnhub] Rate limit hit for ${sym}`);
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        console.warn('[finnhub] API key invalid or expired');
        return null;
      }
      return null;
    }

    const data = (await res.json()) as FinnhubQuoteResponse;
    if (typeof data.c === 'number' && data.c > 0) {
      return data.c;
    }
    return null;
  } catch (e) {
    console.warn(`[finnhub] Quote fetch failed for ${sym}:`, e);
    return null;
  }
}
