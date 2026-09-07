// Sérialise les requêtes par domaine.
//
// collect.ts interrogeait toutes les sources en Promise.all, ce qui allait bien
// tant qu'il n'y avait qu'un seul flux Reddit. Passé à cinq, Reddit renvoie 429
// sur tous sauf le premier — panne invisible, puisqu'une source en échec se
// contente d'un console.warn et rend un tableau vide.
//
// On garde donc le parallélisme ENTRE domaines (c'est lui qui fait la vitesse)
// mais on sérialise à l'intérieur d'un domaine, avec une pause entre deux
// requêtes vers le même hôte.

// 5 s : marge confortable pour les hôtes qui servent plusieurs flux (hnrss.org
// en sert trois). La collecte a 20 min de budget pour ~6 min de travail.
//
// À noter, appris à la dure : ce délai ne sauve PAS Reddit. Depuis les IP des
// runners GitHub, Reddit ne laisse passer qu'un seul flux par run et renvoie
// 429 aux suivants quel que soit l'espacement — c'est un quota par IP, pas un
// débit. D'où une seule source Reddit dans la config (r/LocalLLaMA).
const SAME_HOST_DELAY_MS = 5000;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url; // URL malformée : son propre groupe, elle échouera seule
  }
}

export async function mapPerHostSerial<T extends { url: string }, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  delayMs = SAME_HOST_DELAY_MS
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const groups = new Map<string, { item: T; index: number }[]>();

  for (const [index, item] of items.entries()) {
    const host = hostOf(item.url);
    const group = groups.get(host) ?? [];
    group.push({ item, index });
    groups.set(host, group);
  }

  await Promise.all(
    [...groups.values()].map(async (group) => {
      for (let i = 0; i < group.length; i++) {
        results[group[i].index] = await fn(group[i].item);
        if (i < group.length - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
    })
  );

  return results;
}
