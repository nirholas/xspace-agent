/**
 * Pyth Network price feed integration via the Hermes REST/SSE API.
 * Read-only — no on-chain interaction required.
 *
 * Common price feed IDs from https://pyth.network/developers/price-feed-ids
 */

import { HermesClient } from '@pythnetwork/hermes-client';

const HERMES_URL = 'https://hermes.pyth.network';

// Curated feed IDs for tokens commonly used in this platform
export const PRICE_FEED_IDS = {
	SOL:  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
	BTC:  'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
	ETH:  'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
	USDC: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
	BONK: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
	WIF:  '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
	JUP:  '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
	PYTH: '0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
};

let _client = null;

function getClient() {
	if (!_client) {
		_client = new HermesClient(HERMES_URL);
	}
	return _client;
}

function parseParsedPrice(parsedEntry) {
	const p = parsedEntry?.price;
	if (!p) return { price: NaN, confidence: NaN, publishTime: 0 };
	const price = Number(p.price) * 10 ** Number(p.expo);
	const confidence = Number(p.conf) * 10 ** Number(p.expo);
	return { price, confidence, publishTime: parsedEntry.price?.publishTime ?? 0 };
}

/**
 * Get the latest USD price for one or more tokens.
 *
 * @param {string|string[]} symbols  Token symbol(s), e.g. 'SOL' or ['SOL','BTC']
 * @returns {Promise<Record<string, {price: number, confidence: number, publishTime: number}>>}
 */
export async function getPrices(symbols) {
	const syms = Array.isArray(symbols) ? symbols : [symbols];
	const ids = syms.map((s) => {
		const id = PRICE_FEED_IDS[s.toUpperCase()];
		if (!id) throw new Error(`Unknown Pyth feed symbol: ${s}. Known: ${Object.keys(PRICE_FEED_IDS).join(', ')}`);
		return id;
	});

	const client = getClient();
	const update = await client.getLatestPriceUpdates(ids, { parsed: true });
	const parsed = update?.parsed ?? [];

	const idToSym = Object.fromEntries(syms.map((s, i) => [ids[i], s.toUpperCase()]));

	const result = {};
	for (const entry of parsed) {
		const id = entry.id.replace(/^0x/, '');
		const sym = idToSym[id];
		if (!sym) continue;
		result[sym] = parseParsedPrice(entry);
	}
	// fill any missing syms with NaN
	for (const sym of syms.map((s) => s.toUpperCase())) {
		if (!(sym in result)) result[sym] = { price: NaN, confidence: NaN, publishTime: 0 };
	}
	return result;
}

/**
 * Get the USD price for a single token symbol.
 *
 * @param {string} symbol
 * @returns {Promise<{price: number, confidence: number, publishTime: number, symbol: string}>}
 */
export async function getPrice(symbol) {
	const map = await getPrices(symbol);
	return { symbol: symbol.toUpperCase(), ...map[symbol.toUpperCase()] };
}

/**
 * Register a real-time SSE price subscription.
 * Returns an unsubscribe function.
 *
 * @param {string[]} symbols
 * @param {(updates: Record<string, {price: number, confidence: number, publishTime: number}>) => void} onUpdate
 * @returns {() => void} unsubscribe
 */
export function subscribePrices(symbols, onUpdate) {
	const ids = symbols.map((s) => {
		const id = PRICE_FEED_IDS[s.toUpperCase()];
		if (!id) throw new Error(`Unknown Pyth feed: ${s}`);
		return id;
	});

	const idToSymbol = Object.fromEntries(symbols.map((s, i) => [ids[i], s.toUpperCase()]));
	const client = getClient();

	let eventSource = null;

	client.getPriceUpdatesStream(ids, { parsed: true }).then((es) => {
		eventSource = es;
		es.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				const parsed = data?.parsed ?? [];
				const updates = {};
				for (const entry of parsed) {
					const id = entry.id.replace(/^0x/, '');
					const sym = idToSymbol[id];
					if (!sym) continue;
					updates[sym] = parseParsedPrice(entry);
				}
				if (Object.keys(updates).length > 0) onUpdate(updates);
			} catch {
				// ignore parse errors
			}
		};
	});

	return () => {
		if (eventSource) eventSource.close();
	};
}
