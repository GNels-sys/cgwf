package cgwf.engine;

import forge.game.Game;
import forge.game.card.Card;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayDeque;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Test helper: walks the object graph from a Game and counts the Card objects it reaches that are not cards of the
 * game (last-known-information copies, earlier selves of cards that changed zone), with the field paths that lead to
 * them. This is how the 2026-11-22 memory leak was found: `jcmd GC.class_histogram` said 34,000 Card objects after
 * fifty casts, and the walk said which fields held them.
 */
final class RetentionWalk {
    private record Node(Object o, String path, int depth) { }

    /** How many stray copies the game keeps alive; `paths` (may be null) gets the busiest routes to them. */
    static int count(Game game, List<String> paths) {
        Set<Card> real = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Card c : game.getCardsInGame()) real.add(c);
        Map<Object, Boolean> seen = new IdentityHashMap<>();
        Map<String, Integer> via = new HashMap<>();
        ArrayDeque<Node> queue = new ArrayDeque<>();
        queue.add(new Node(game, "Game", 0));
        seen.put(game, true);
        int strays = 0;
        while (!queue.isEmpty()) {
            Node n = queue.poll();
            if (n.path().startsWith("(copy") && n.path().length() > 400) n = new Node(n.o(), n.path().substring(0, 400), n.depth());
            Object o = n.o();
            if (o instanceof Card c && !real.contains(c)) {
                strays++;
                String shortPath = n.path().length() > 230 ? "..." + n.path().substring(n.path().length() - 230) : n.path();
                via.merge(shortPath, 1, Integer::sum);
                // walk on INTO the copy too: what it holds is kept alive by it
                n = new Node(o, "(copy of " + c.getName().replaceAll("[0-9]", "") + ")", n.depth());
            }
            if (n.depth() > 400) continue;
            Class<?> k = o.getClass();
            if (k.isArray()) {
                if (k.getComponentType().isPrimitive()) continue;
                for (int i = 0; i < Array.getLength(o); i++) push(queue, seen, Array.get(o, i), n.path() + "[]", n.depth() + 1);
                continue;
            }
            String pkg = k.getName();
            if (o instanceof Map<?, ?> m) {
                try {
                    for (Map.Entry<?, ?> e : m.entrySet()) {
                        push(queue, seen, e.getKey(), n.path() + "{k}", n.depth() + 1);
                        push(queue, seen, e.getValue(), n.path() + "{v}", n.depth() + 1);
                    }
                } catch (RuntimeException ignored) { }
                if (!pkg.startsWith("forge.")) continue;
            } else if (o instanceof java.util.concurrent.atomic.AtomicReference<?> ar) {
                push(queue, seen, ar.get(), n.path() + "<ref>", n.depth() + 1);
                continue;
            } else if (o instanceof Collection<?> col) {
                try {
                    for (Object e : col) push(queue, seen, e, n.path() + "[]", n.depth() + 1);
                } catch (RuntimeException ignored) { }
                if (!pkg.startsWith("forge.")) continue;
            } else if (o instanceof com.google.common.collect.Table<?, ?, ?> t) {
                try {
                    for (Object cell : t.values()) push(queue, seen, cell, n.path() + "<t>", n.depth() + 1);
                    for (Object r : t.rowKeySet()) push(queue, seen, r, n.path() + "<r>", n.depth() + 1);
                    for (Object c2 : t.columnKeySet()) push(queue, seen, c2, n.path() + "<c>", n.depth() + 1);
                } catch (RuntimeException ignored) { }
                continue;
            } else if (o instanceof com.google.common.collect.Multimap<?, ?> mm) {
                try {
                    for (Object v : mm.values()) push(queue, seen, v, n.path() + "<mm>", n.depth() + 1);
                } catch (RuntimeException ignored) { }
                continue;
            }
            if (pkg.startsWith("java.") || pkg.startsWith("javax.") || pkg.startsWith("jdk.") || pkg.startsWith("sun.") || pkg.startsWith("com.sun.")) continue;
            for (Class<?> c = k; c != null && c != Object.class; c = c.getSuperclass()) {
                for (Field f : c.getDeclaredFields()) {
                    if (Modifier.isStatic(f.getModifiers()) || f.getType().isPrimitive()) continue;
                    try {
                        f.setAccessible(true);
                        Object v = f.get(o);
                        push(queue, seen, v, n.path() + " > " + c.getSimpleName() + "." + f.getName(), n.depth() + 1);
                    } catch (Throwable ignored) { }
                }
            }
        }
        if (paths != null) {
            List<Map.Entry<String, Integer>> top = via.entrySet().stream().sorted((a, b) -> b.getValue() - a.getValue()).limit(8).toList();
            for (Map.Entry<String, Integer> e : top) paths.add(e.getValue() + "  " + e.getKey());
        }
        return strays;
    }

    private static void push(ArrayDeque<Node> queue, Map<Object, Boolean> seen, Object v, String path, int depth) {
        if (v == null || v instanceof String || v instanceof Number || v instanceof Boolean || v instanceof Enum<?> || v instanceof Class<?>) return;
        if (seen.put(v, true) != null) return;
        queue.add(new Node(v, path, depth));
    }

    private RetentionWalk() { }
}
