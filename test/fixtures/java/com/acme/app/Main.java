package com.acme.app;

import com.acme.core.Engine;
import static com.acme.core.Util.twice;

public class Main {
    public static void main(String[] args) {
        Engine e = new Engine("a");
        e.run();
        twice(3);
        new Main().go();
    }

    void go() { helper(); }
    private void helper() {}
}
