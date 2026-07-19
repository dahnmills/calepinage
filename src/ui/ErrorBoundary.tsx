import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Garde-fou : une erreur de rendu (géométrie dégénérée, donnée inattendue…) affichait
 * jusqu'ici une PAGE BLANCHE sans le moindre indice. On l'attrape et on montre le message
 * exact + le plan reste récupérable (recharger, ou repartir de zéro). L'erreur complète
 * part aussi dans la console pour le diagnostic.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[calepinage] crash de rendu :', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '40px auto' }}>
        <h2 style={{ color: '#b91c1c' }}>Une erreur d'affichage est survenue</h2>
        <p>Le plan n'est pas perdu. Tu peux recharger la page ; s'il faut, exporte ton plan avant.</p>
        <pre style={{ background: '#f1f5f9', padding: 12, borderRadius: 8, overflow: 'auto', fontSize: 13 }}>
          {error.message}
        </pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={() => this.setState({ error: null })}>Réessayer l'affichage</button>
          <button onClick={() => location.reload()}>Recharger la page</button>
        </div>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: 16 }}>
          Le détail complet (avec l'endroit exact) est dans la console du navigateur (F12).
        </p>
      </div>
    );
  }
}
