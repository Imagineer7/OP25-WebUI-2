/* -*- c++ -*- */
/* 
 * Copyright 2025 Graham J. Norbury
 * 
 * This is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 3, or (at your option)
 * any later version.
 * 
 * This software is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this software; see the file COPYING.  If not, write to
 * the Free Software Foundation, Inc., 51 Franklin Street,
 * Boston, MA 02110-1301, USA.
 */

#ifndef INCLUDED_OP25_REPEATER_OP25_CRYPT_ALGS_H
#define INCLUDED_OP25_REPEATER_OP25_CRYPT_ALGS_H

#include <gnuradio/msg_queue.h>
#include <unordered_map>

#include "op25_crypt.h"
#include "op25_crypt_alg.h"
#include "log_ts.h"

class op25_crypt_algs
{
    private:
        log_ts& logts;
        int d_debug;
        int d_msgq_id;
        std::unordered_map<uint8_t, op25_crypt_alg*> d_algs;
        std::unordered_map<uint8_t, op25_crypt_alg*>::const_iterator d_alg_iter;

    public:
        op25_crypt_algs(log_ts& logger, int debug, int msgq_id);
        ~op25_crypt_algs();

        void key(uint16_t keyid, uint8_t algid, const std::vector<uint8_t> &key);
        bool prepare(uint8_t algid, uint16_t keyid, protocol_type pr_type, uint8_t *MI);
        bool process(packed_codeword& PCW, frame_type fr_type, int voice_subframe);
        void reset(void);
        inline void set_debug(int debug) {d_debug = debug;}

        static void cycle_p25_lfsr(uint8_t *MI); 
};

#endif /* INCLUDED_OP25_REPEATER_OP25_CRYPT_ALGS_H  */
