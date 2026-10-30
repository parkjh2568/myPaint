#include <sys/socket.h>
#include <unistd.h>
int main() {
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd >= 0)
        close(fd);
    // This test expects network_guard to terminate us before reaching this point.
    return 0;
}
