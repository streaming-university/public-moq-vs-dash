#!/bin/bash
while [ $# -gt 0 ]; do
    if [[ $1 == *"--"* ]] && [[ ! -z $2 ]] && [[ $2 != *"--"* ]]; then
        param="${1/--/}"
        declare $param="$2"
        # echo $1 $2 # Optional to see the parameter:value result
        shift 2
    else
        shift
    fi
done
