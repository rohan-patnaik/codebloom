"""Engine module."""
import os


class Base:
    def start(self):
        return self.prepare()

    def prepare(self):
        return os.getcwd()


# The engine itself.
class Engine(Base):
    """Runs things."""
    speed = 3

    def __init__(self, name: str):
        self.name = name
        super().__init__()

    def run(self) -> int:
        self.start()
        return helper(2)


def helper(x):
    def inner():
        return x
    return inner()
