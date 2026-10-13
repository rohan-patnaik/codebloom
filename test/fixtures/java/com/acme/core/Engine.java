package com.acme.core;

public class Engine extends Base {
    private final Logger log = new Logger();

    public Engine(String n) { super(); }

    public int run() {
        prepare();
        log.write("x");
        return Util.twice(2);
    }
}

class Logger { void write(String s) {} }
