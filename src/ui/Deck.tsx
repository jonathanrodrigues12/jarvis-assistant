import { memo, useMemo } from 'react'
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion'
import { useStore, isCard, type Blade } from '../store'
import { Body } from './Blades'

/**
 * The deck — how a briefing builds up on screen.
 *
 * Each card JARVIS puts up lands in the middle, over the orb, while he talks
 * about it. When the next one arrives the previous card does not vanish: it
 * shrinks down into a row along the bottom, so by the end of "bom dia" the
 * whole day is laid out in a line under the orb — weather, agenda, mail, news —
 * and any of them can be pulled back to the centre with a click.
 *
 * The move from centre to row is one shared-layout animation per card
 * (`layoutId`), which is why the two places are rendered in one LayoutGroup
 * and centred with flex rather than transforms: layout projection cannot
 * measure through a transformed ancestor.
 */

/** A glyph for the card's corner, read from what the card says it is about. */
function glyphFor(card: Blade): string {
  const s = `${card.kicker ?? ''} ${card.title}`.toLowerCase()
  if (/clima|tempo|weather|previs/.test(s)) return '☼'
  if (/agenda|calend|compromiss|reuni/.test(s)) return '▦'
  if (/e-?mail|caixa|inbox|mensag/.test(s)) return '✉'
  if (/not[ií]cia|manchete|radar|news/.test(s)) return '◉'
  if (/sa[uú]de|sono|prontid|recupera/.test(s)) return '♥'
  if (/observa|lembrete|alerta/.test(s)) return '◬'
  return '◇'
}

const CardView = memo(function CardView({
  card,
  mini,
  onPick,
}: {
  card: Blade
  mini: boolean
  onPick?: () => void
}) {
  return (
    <motion.section
      layoutId={`card-${card.id}`}
      className={`deck-card${mini ? ' deck-mini' : ''}`}
      onClick={onPick}
      initial={{ opacity: 0, scale: 0.92, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      exit={{ opacity: 0, scale: 0.96, filter: 'blur(6px)', transition: { duration: 0.25 } }}
      transition={{ type: 'spring', stiffness: 220, damping: 28 }}
    >
      <header className="deck-head">
        <span className="deck-icon">{glyphFor(card)}</span>
        <span className="deck-titles">
          {card.kicker && <span className="deck-kicker">{card.kicker}</span>}
          <span className="deck-title">{card.title}</span>
        </span>
        {card.tag && <span className="deck-tag">{card.tag}</span>}
      </header>
      <div className="deck-body">
        <Body blade={card} />
      </div>
    </motion.section>
  )
})

export function Deck() {
  const blades = useStore((s) => s.blades)
  const focused = useStore((s) => s.focusedBlade)
  const focusBlade = useStore((s) => s.focusBlade)

  const cards = useMemo(() => blades.filter(isCard), [blades])
  if (!cards.length) return null

  const front = cards.find((c) => c.id === focused) ?? cards[cards.length - 1]
  const row = cards.filter((c) => c.id !== front.id)

  return (
    <LayoutGroup id="deck">
      {/* With a row underneath, the focus card rises to make room for it. */}
      <div className={`deck-focus${row.length ? ' deck-focus-up' : ''}`}>
        <AnimatePresence mode="popLayout">
          <CardView key={front.id} card={front} mini={false} />
        </AnimatePresence>
      </div>
      <div className="deck-row">
        <AnimatePresence mode="popLayout">
          {row.map((c) => (
            <CardView key={c.id} card={c} mini onPick={() => focusBlade(c.id)} />
          ))}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  )
}
