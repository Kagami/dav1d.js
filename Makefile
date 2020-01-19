all: dav1d.wasm

patch:
	patch -d dav1d -p1 <dav1d.patch

build/dist/lib/libdav1d.a:
	meson setup \
		--prefix="$(CURDIR)/build/dist" \
		--cross-file=cross_file.txt \
		--default-library=static \
		--buildtype=release \
		-Dbitdepths="['8']" \
		-Dbuild_asm=false \
		-Dbuild_tools=false \
		-Dbuild_tests=false \
		-Dlogging=false \
		./dav1d ./build \
	&& ninja -C ./build install

dav1d.wasm: dav1d.c build/dist/lib/libdav1d.a
	emcc $^ -DNDEBUG -Os --llvm-lto 3 -Ibuild/dist/include -o $@ \
		-s TOTAL_MEMORY=67108864 -s MALLOC=emmalloc

.PHONY: test
test: dav1d.c
	$(CC) $^ $(CFLAGS) -O2 -Wall -o $@ \
		-I../tmp/dav1d/dist/include -L../tmp/dav1d/dist/lib \
		-ldav1d -lpthread

test-native: test
	./test

test-valgrind: CFLAGS = -DDJS_VALGRIND
test-valgrind: test
	valgrind ./test

test-node: dav1d.wasm
	node --experimental-modules --preserve-symlinks test.mjs

clean: clean-build clean-wasm clean-test
clean-build:
	rm -rf build
clean-wasm:
	rm -f dav1d.wasm
clean-test:
	rm -f test
