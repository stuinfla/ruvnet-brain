// Minimum-cut walker over a dependency graph (fixture code, second generation only).
pub fn zephyrlattice_mincut(edges: &[(u32, u32, f32)]) -> f32 {
    edges.iter().map(|e| e.2).fold(f32::INFINITY, f32::min)
}
