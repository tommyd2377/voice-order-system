import { db } from '../firebase.js';

const MENU_DEBUG_LOGS = process.env.MENU_DEBUG_LOGS === 'true';

const MATCH_CONFIDENCE_THRESHOLD = 0.6;
const MAX_SUGGESTIONS = 3;

const normalize = (value) => (value || '').toString().trim().toLowerCase();

const scoreMatch = (inputName, candidateName) => {
  const input = normalize(inputName);
  const candidate = normalize(candidateName);
  if (!input || !candidate) return 0;
  if (input === candidate) return 1;
  if (candidate.includes(input) || input.includes(candidate)) {
    return 0.8;
  }
  return 0;
};

const resolveRestaurantId = async (restaurantIdInput) => {
  const input = restaurantIdInput || '';
  if (!input || /\s/.test(input) || input.length < 12) {
    try {
      const byName = await db.collection('restaurants').where('name', '==', input).limit(1).get();
      if (!byName.empty) {
        console.warn('[Menu] restaurantId looked like a name; resolved by name lookup', {
          restaurantIdInput: input,
          restaurantDocId: byName.docs[0].id,
        });
        return byName.docs[0].id;
      }
    } catch (err) {
      console.error('[Menu] restaurant lookup by name failed', { restaurantIdInput: input, err });
    }
  }
  return input || null;
};

const fetchMenuItems = async (restaurantIdInput) => {
  const restaurantDocId = await resolveRestaurantId(restaurantIdInput);
  if (!restaurantDocId) {
    console.error('[Menu] invalid restaurantId for pricing', { restaurantIdInput });
    return { menuItems: [], restaurantDocId: null };
  }
  try {
    const primarySnap = await db.collection('restaurants').doc(restaurantDocId).collection('menuItems').get();
    const docs = primarySnap?.docs || [];

    const menuItems = docs.map((doc) => {
      const data = doc.data() || {};
      const name = data.name || data.title || '';
      return {
        id: doc.id,
        name,
        title: data.title || name,
        priceCents: data.priceCents ?? null,
        isAvailable: data.isAvailable !== false,
      };
    });

    if (MENU_DEBUG_LOGS) {
      console.log('[Menu] pricing menuItems loaded', {
        restaurantIdInput,
        restaurantDocId,
        path: `restaurants/${restaurantDocId}/menuItems`,
        count: menuItems.length,
        sample: menuItems.slice(0, 25),
      });
    }
    return { menuItems, restaurantDocId };
  } catch (err) {
    console.warn('[Menu] failed to fetch menu for pricing', { restaurantIdInput, err });
    return { menuItems: [], restaurantDocId: null };
  }
};

const buildSuggestions = (menuItems, originalName) => {
  const scored = menuItems
    .map((item) => ({
      item,
      score: scoreMatch(originalName, item.name || item.title),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS)
    .filter((entry) => entry.score > 0);

  return scored.map(({ item }) => ({
    menuItemId: item.id || null,
    name: item.name || item.title || 'Unknown item',
    priceCents: item.priceCents ?? null,
  }));
};

const mapResolvedItem = (inputItem, match) => {
  const priceCents = match?.priceCents ?? null;
  const quantity = inputItem.quantity || 1;
  const lineTotalCents = priceCents != null ? priceCents * quantity : null;

  return {
    menuItemId: match?.id || null,
    name: match?.name || match?.title || inputItem.name,
    originalName: inputItem.name,
    quantity,
    notes: inputItem.notes || null,
    priceCents,
    lineTotalCents,
    matchConfidence: match?.matchConfidence ?? null,
    matchedName: match?.name || match?.title || null,
  };
};

export async function resolveOrderPricing({
  restaurantId,
  items = [],
  fulfillmentType,
  deliveryAddress,
  deliveryApt,
  deliveryNotes,
}) {
  const { menuItems, restaurantDocId } = await fetchMenuItems(restaurantId);
  const resolvedItems = [];
  const unmatched = [];

  for (const item of items) {
    const inputName = item?.name || '';
    const quantity = item?.quantity || 1;
    const notes = item?.notes || null;

    let bestMatch = null;
    let bestScore = 0;

    for (const menuItem of menuItems) {
      if (menuItem.isAvailable === false) continue;
      const score = scoreMatch(inputName, menuItem.name || menuItem.title);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { ...menuItem, matchConfidence: score };
      }
    }

    if (bestMatch && bestScore >= MATCH_CONFIDENCE_THRESHOLD) {
      if (MENU_DEBUG_LOGS) {
        console.log('[Menu] pricing match', {
          inputName,
          quantity,
          notes,
          bestMatch: {
            id: bestMatch.id,
            name: bestMatch.name || bestMatch.title,
            priceCents: bestMatch.priceCents,
            score: bestScore,
          },
          passedThreshold: true,
        });
      }
      resolvedItems.push(
        mapResolvedItem(
          { name: inputName, quantity, notes },
          { ...bestMatch, matchConfidence: bestScore }
        )
      );
    } else {
      const suggestions = buildSuggestions(menuItems, inputName);
      if (MENU_DEBUG_LOGS) {
        console.log('[Menu] pricing no confident match', {
          inputName,
          quantity,
          notes,
          bestScore,
          suggestions,
        });
      }
      resolvedItems.push(
        mapResolvedItem({ name: inputName, quantity, notes }, null)
      );
      unmatched.push({
        originalName: inputName,
        suggestions,
      });
    }
  }

  const subtotalCents = resolvedItems.reduce(
    (sum, item) => sum + (item.lineTotalCents || 0),
    0
  );
  const taxCents = null;
  const totalCents = subtotalCents + (taxCents || 0);

  if (MENU_DEBUG_LOGS) {
    const nullPrices = resolvedItems.filter((item) => item.priceCents == null).length;
    console.log('[Menu] pricing totals', {
      restaurantId: restaurantDocId || restaurantId,
      subtotalCents,
      taxCents,
      totalCents,
      resolvedCount: resolvedItems.length,
      nullPriceCount: nullPrices,
    });
  }

  return {
    restaurantId: restaurantDocId || restaurantId || null,
    fulfillmentType: fulfillmentType || null,
    deliveryAddress: deliveryAddress || null,
    deliveryApt: deliveryApt || null,
    deliveryNotes: deliveryNotes || null,
    resolvedItems,
    unmatched,
    subtotalCents,
    taxCents,
    totalCents,
  };
}
