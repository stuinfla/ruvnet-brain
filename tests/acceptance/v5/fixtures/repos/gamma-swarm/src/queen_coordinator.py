"""Queen coordinator for a small agent swarm (fixture code)."""


class ThistledownQueen:
    def __init__(self, workers):
        self.workers = list(workers)

    def assign(self, tasks):
        """Round-robin assignment with a hollowmere backoff when a worker is busy."""
        plan = {}
        for i, task in enumerate(tasks):
            plan.setdefault(self.workers[i % len(self.workers)], []).append(task)
        return plan
