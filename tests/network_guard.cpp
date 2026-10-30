// Linux test instrumentation only: fail the subprocess if it requests Internet I/O.
// This interposes libc APIs; it is not a kernel sandbox or a packet capture.
#include <cstdlib>
#include <dlfcn.h>
#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

extern "C" int socket(int domain, int type, int protocol) {
    if (domain == AF_INET || domain == AF_INET6) {
        constexpr char message[] = "OFFLINE TEST FAILED: Internet socket requested\n";
        (void)!write(STDERR_FILENO, message, sizeof(message) - 1);
        std::_Exit(90);
    }
    const auto original = reinterpret_cast<int (*)(int, int, int)>(dlsym(RTLD_NEXT, "socket"));
    if (!original)
        std::_Exit(91);
    return original(domain, type, protocol);
}
extern "C" int connect(int fd, const sockaddr *address, socklen_t length) {
    if (address && (address->sa_family == AF_INET || address->sa_family == AF_INET6)) {
        constexpr char message[] = "OFFLINE TEST FAILED: Internet connection requested\n";
        (void)!write(STDERR_FILENO, message, sizeof(message) - 1);
        std::_Exit(92);
    }
    const auto original =
        reinterpret_cast<int (*)(int, const sockaddr *, socklen_t)>(dlsym(RTLD_NEXT, "connect"));
    if (!original)
        std::_Exit(93);
    return original(fd, address, length);
}
extern "C" int getaddrinfo(const char *, const char *, const addrinfo *, addrinfo **) {
    constexpr char message[] = "OFFLINE TEST FAILED: name resolution requested\n";
    (void)!write(STDERR_FILENO, message, sizeof(message) - 1);
    std::_Exit(94);
}
