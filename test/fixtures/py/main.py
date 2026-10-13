import pkg
from pkg import Engine
from pkg.engine import helper as h

engine = Engine("a")


def go(e: Engine):
    e.run()
    engine.run()
    h(1)
    pkg.Engine("b")


if __name__ == "__main__":
    go(Engine("c"))
