execute_process(
    COMMAND "${CMAKE_COMMAND}" -E env "LD_PRELOAD=${GUARD}" "${PROBE}"
    RESULT_VARIABLE guard_result
    OUTPUT_VARIABLE guard_output
    ERROR_VARIABLE guard_error
)
if(NOT guard_result STREQUAL "90" OR
   NOT guard_error MATCHES "OFFLINE TEST FAILED: Internet socket requested")
    message(FATAL_ERROR "Network guard did not reject the probe as expected: ${guard_result}\n${guard_output}${guard_error}")
endif()
