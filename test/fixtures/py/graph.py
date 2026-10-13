"""A LangGraph-style workflow: nodes are registered, never called directly."""
from pkg.engine import helper


def plan_node(state):
    return helper(state)


@app.route("/review")
def review_node(state):
    return state


def build(graph):
    graph.add_node("plan", plan_node)
    graph.add_node("review", review_node)
    handlers = {"plan": plan_node}
    return handlers
