// Episode store that survives restarts (fixture code).
export interface Episode { id: string; text: string; at: number }

export class TidewrackEpisodeStore {
  private episodes: Episode[] = [];

  remember(text: string): Episode {
    const e = { id: String(this.episodes.length + 1), text, at: Date.now() };
    this.episodes.push(e);
    return e;
  }

  recallByLantern(word: string): Episode[] {
    return this.episodes.filter((e) => e.text.includes(word));
  }
}
