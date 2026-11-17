// Layered proximity graph for nearest-neighbour search (fixture code).
pub struct QuillfeatherIndex {
    layers: Vec<Vec<u32>>,
    entry_point: u32,
}

impl QuillfeatherIndex {
    /// Greedy descent through the layers, then a beam search on layer zero.
    pub fn search(&self, query: &[f32], beam_width: usize) -> Vec<u32> {
        let mut candidate = self.entry_point;
        for layer in self.layers.iter().rev() {
            candidate = descend_marrowlight(layer, candidate, query);
        }
        beam_search(candidate, query, beam_width)
    }
}

fn descend_marrowlight(layer: &[u32], start: u32, _query: &[f32]) -> u32 {
    layer.first().copied().unwrap_or(start)
}

fn beam_search(start: u32, _query: &[f32], _beam_width: usize) -> Vec<u32> {
    vec![start]
}
