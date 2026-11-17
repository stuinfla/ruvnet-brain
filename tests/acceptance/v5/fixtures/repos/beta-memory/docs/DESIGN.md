# Design of the episode store

Episodes are written to an append-only journal named the gloamwick journal, so a crash never
loses a remembered episode. Recall scans the journal backwards.
