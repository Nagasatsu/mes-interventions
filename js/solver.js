// Calcule l'ordre de passage qui minimise le temps total de trajet.
//
// C'est le problème du « voyageur de commerce », version chemin ouvert :
// le point de départ et le point d'arrivée sont imposés, on cherche le
// meilleur ordre pour toutes les étapes entre les deux.
//
// - Jusqu'à 8 étapes : on essaie tous les ordres possibles (résultat parfait).
// - Au-delà : on part du « plus proche voisin », on améliore par petites
//   retouches (2-opt et or-opt), puis on secoue la solution et on recommence
//   tant qu'il reste du temps. Pour 30 étapes, ça donne en pratique la
//   meilleure tournée ou une tournée à quelques secondes près.
//
// `m` est une matrice de coûts : m[a][b] = temps pour aller de a à b.
// Elle peut être asymétrique (sens uniques, autoroutes…).

const EPS = 1e-9;
const BRUTE_FORCE_MAX = 8;

export function pathCost(m, path) {
  let cost = 0;
  for (let i = 0; i < path.length - 1; i++) cost += m[path[i]][path[i + 1]];
  return cost;
}

export function optimizeOrder(m, start, end, stops, timeBudgetMs = 400) {
  if (stops.length <= 1) return [...stops];
  if (stops.length <= BRUTE_FORCE_MAX) return bruteForce(m, start, end, stops);

  let best = localSearch(m, [start, ...nearestNeighbor(m, start, stops), end]);
  let bestCost = pathCost(m, best);
  const deadline = performance.now() + timeBudgetMs;
  while (performance.now() < deadline) {
    const candidate = localSearch(m, doubleBridge(best));
    const cost = pathCost(m, candidate);
    if (cost < bestCost - EPS) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best.slice(1, -1);
}

function bruteForce(m, start, end, stops) {
  const perm = [...stops];
  let best = [...stops];
  let bestCost = Infinity;
  const permute = (k) => {
    if (k === perm.length) {
      const cost = pathCost(m, [start, ...perm, end]);
      if (cost < bestCost) {
        bestCost = cost;
        best = [...perm];
      }
      return;
    }
    for (let i = k; i < perm.length; i++) {
      [perm[k], perm[i]] = [perm[i], perm[k]];
      permute(k + 1);
      [perm[k], perm[i]] = [perm[i], perm[k]];
    }
  };
  permute(0);
  return best;
}

function nearestNeighbor(m, start, stops) {
  const left = new Set(stops);
  const order = [];
  let current = start;
  while (left.size) {
    let next;
    let nextCost = Infinity;
    for (const s of left) {
      if (m[current][s] < nextCost) {
        nextCost = m[current][s];
        next = s;
      }
    }
    order.push(next);
    left.delete(next);
    current = next;
  }
  return order;
}

// Applique des retouches tant qu'elles font gagner du temps.
// Le premier et le dernier point du chemin ne bougent jamais.
function localSearch(m, path) {
  const P = [...path];
  while (twoOpt(m, P) || orOpt(m, P)) {
    // on recommence jusqu'à ce qu'aucune retouche n'aide plus
  }
  return P;
}

// 2-opt : inverse le sens de parcours d'un morceau du chemin.
function twoOpt(m, P) {
  const N = P.length;
  // F[t] / R[t] : coût cumulé jusqu'à P[t] dans le sens normal / inversé,
  // pour connaître en un calcul le coût d'un morceau parcouru à l'envers.
  const F = new Float64Array(N);
  const R = new Float64Array(N);
  for (let t = 1; t < N; t++) {
    F[t] = F[t - 1] + m[P[t - 1]][P[t]];
    R[t] = R[t - 1] + m[P[t]][P[t - 1]];
  }
  for (let i = 1; i < N - 2; i++) {
    for (let j = i + 1; j < N - 1; j++) {
      const delta =
        m[P[i - 1]][P[j]] + m[P[i]][P[j + 1]] -
        m[P[i - 1]][P[i]] - m[P[j]][P[j + 1]] +
        (R[j] - R[i]) - (F[j] - F[i]);
      if (delta < -EPS) {
        reverse(P, i, j);
        return true;
      }
    }
  }
  return false;
}

// Or-opt : déplace un bloc de 1 à 3 étapes consécutives ailleurs dans le chemin.
function orOpt(m, P) {
  const N = P.length;
  for (let len = 1; len <= 3; len++) {
    for (let i = 1; i + len - 1 <= N - 2; i++) {
      const j = i + len - 1;
      const prev = P[i - 1];
      const next = P[j + 1];
      const first = P[i];
      const last = P[j];
      const removeGain = m[prev][first] + m[last][next] - m[prev][next];
      for (let k = 0; k < N - 1; k++) {
        if (k >= i - 1 && k <= j) continue;
        const u = P[k];
        const v = P[k + 1];
        const delta = m[u][first] + m[last][v] - m[u][v] - removeGain;
        if (delta < -EPS) {
          moveBlock(P, i, j, k);
          return true;
        }
      }
    }
  }
  return false;
}

function reverse(P, i, j) {
  while (i < j) {
    [P[i], P[j]] = [P[j], P[i]];
    i++;
    j--;
  }
}

// Déplace P[i..j] juste après l'élément qui était en position k.
function moveBlock(P, i, j, k) {
  const block = P.splice(i, j - i + 1);
  const at = k < i ? k + 1 : k + 1 - block.length;
  P.splice(at, 0, ...block);
}

// « Double pont » : coupe le chemin en 4 morceaux A B C D et le remonte en
// A C B D. Ce mélange est difficile à défaire par petites retouches, ce qui
// permet d'explorer d'autres solutions.
function doubleBridge(path) {
  const inner = path.slice(1, -1);
  const n = inner.length;
  const cuts = new Set();
  while (cuts.size < 3) cuts.add(1 + Math.floor(Math.random() * (n - 1)));
  const [a, b, c] = [...cuts].sort((x, y) => x - y);
  return [
    path[0],
    ...inner.slice(0, a),
    ...inner.slice(b, c),
    ...inner.slice(a, b),
    ...inner.slice(c),
    path[path.length - 1],
  ];
}
